import { describe, expect, it, vi } from "vitest";
import { createApp, isPrivateAddress } from "../src/app.ts";

const post = (app: ReturnType<typeof createApp>, body: unknown) =>
  app.request("/tts", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

describe("tts", () => {
  it("keeps the key server-side and proxies audio", async () => {
    const f = vi.fn(async () => new Response("AUDIO", { status: 200 }));
    const app = createApp({ apiKey: "secret", fetch: f as never });
    const res = await post(app, { text: "hi", voice_id: "abcdefghij12" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("AUDIO");
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/text-to-speech/abcdefghij12");
    expect((init.headers as Record<string, string>)["xi-api-key"]).toBe("secret");
  });

  it("validates input and surfaces 429", async () => {
    const app = createApp({ apiKey: "k", fetch: (async () => new Response("", { status: 429 })) as never });
    expect((await post(app, { text: "", voice_id: "abcdefghij12" })).status).toBe(400);
    expect((await post(app, { text: "x", voice_id: "../etc" })).status).toBe(400);
    expect((await post(app, { text: "x", voice_id: "abcdefghij12" })).status).toBe(429);
  });

  it("errors without a key", async () => {
    delete process.env.ELEVENLABS_API_KEY;
    expect((await post(createApp(), { text: "x", voice_id: "abcdefghij12" })).status).toBe(500);
  });
});

describe("fetch proxy", () => {
  it("blocks private addresses", async () => {
    expect(isPrivateAddress("10.0.0.5")).toBe(true);
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
    const app = createApp({ resolveHost: async () => ["127.0.0.1"] });
    expect((await app.request("/fetch?url=http://localhost/x")).status).toBe(403);
    expect((await app.request("/fetch?url=http://169.254.169.254/")).status).toBe(403);
    expect((await app.request("/fetch?url=file:///etc/passwd")).status).toBe(400);
  });

  it("fetches public pages", async () => {
    const app = createApp({ resolveHost: async () => ["93.184.216.34"], fetch: (async () => new Response("<p>hi</p>", { headers: { "content-type": "text/html" } })) as never });
    const j = await (await app.request("/fetch?url=https://example.com/a")).json();
    expect(j.body).toBe("<p>hi</p>");
  });
});

import { sanitize, parseInput } from "../src/suggest.ts";

describe("suggest", () => {
  const input = parseInput({ title: "Quantum", excerpt: "text", vocabulary: ["Physics", "cooking"], collections: [] })!;

  it("rejects bad input and reports a missing key", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const app = createApp();
    const bad = await app.request("/suggest", { method: "POST", body: JSON.stringify({}), headers: { "content-type": "application/json" } });
    expect(bad.status).toBe(400);
    const nokey = await app.request("/suggest", { method: "POST", body: JSON.stringify({ title: "t", excerpt: "e" }), headers: { "content-type": "application/json" } });
    expect(nokey.status).toBe(501);
  });

  it("calls the model with schema output and fallbacks, and sanitizes the result", async () => {
    const create = vi.fn(async (_args: Record<string, unknown>) => ({
      stop_reason: "end_turn",
      content: [{ type: "text", text: JSON.stringify({ tags: ["physics", "quantum", "Quantum", "x".repeat(80)], collection: " Science/Physics ", summary: "About quanta." }) }],
    }));
    const app = createApp({ anthropic: { beta: { messages: { create } } } as never, model: "claude-opus-5-5" });
    const res = await app.request("/suggest", { method: "POST", body: JSON.stringify({ title: "Quantum", excerpt: "e", vocabulary: ["Physics"] }), headers: { "content-type": "application/json" } });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.tags.slice(0, 2)).toEqual(["Physics", "quantum"]);
    expect(j.tags).toHaveLength(3);
    expect(j.collection).toBe("Science/Physics");
    const args = create.mock.calls[0]![0];
    expect(args.fallbacks).toBe("default");
    expect(args.model).toBe("claude-opus-5-5");
  });

  it("surfaces refusals as an upstream failure", async () => {
    const create = async () => ({ stop_reason: "refusal", content: [] });
    const app = createApp({ anthropic: { beta: { messages: { create } } } as never });
    const res = await app.request("/suggest", { method: "POST", body: JSON.stringify({ title: "t", excerpt: "e" }), headers: { "content-type": "application/json" } });
    expect(res.status).toBe(502);
  });

  it("sanitize tolerates garbage", () => {
    expect(sanitize(null, input)).toEqual({ tags: [], collection: undefined, summary: "" });
  });
});
