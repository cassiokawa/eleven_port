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
