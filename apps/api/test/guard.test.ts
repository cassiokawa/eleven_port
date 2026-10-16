import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";

const req = (app: ReturnType<typeof createApp>, path: string, init: RequestInit = {}) => app.request(path, init);

describe("guard", () => {
  it("requires the bearer token when configured, but leaves /health open", async () => {
    const app = createApp({ guard: { token: "s3cret" } });
    expect((await req(app, "/health")).status).toBe(200);
    expect((await req(app, "/fetch?url=https://example.com")).status).toBe(401);
    expect((await req(app, "/fetch?url=https://example.com", { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await req(app, "/fetch?url=notaurl", { headers: { authorization: "Bearer s3cret" } })).status).toBe(400);
  });

  it("enforces the CORS allowlist and answers preflight", async () => {
    const app = createApp({ guard: { allowedOrigins: ["https://app.example"] } });
    const ok = await req(app, "/health", { headers: { origin: "https://app.example" } });
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://app.example");
    expect((await req(app, "/fetch?url=x", { headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await req(app, "/tts", { method: "OPTIONS", headers: { origin: "https://app.example" } })).status).toBe(204);
    expect((await req(app, "/tts", { method: "OPTIONS", headers: { origin: "https://evil.example" } })).status).toBe(403);
  });

  it("rate limits per client and recovers after the window", async () => {
    let t = 0;
    const app = createApp({ guard: { limit: 2, windowMs: 1000, now: () => t } });
    const hit = () => req(app, "/fetch?url=x", { headers: { "x-forwarded-for": "1.1.1.1" } });
    expect((await hit()).status).toBe(400);
    expect((await hit()).status).toBe(400);
    const limited = await hit();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("1");
    t = 1500;
    expect((await hit()).status).toBe(400);
    const other = await req(app, "/fetch?url=x", { headers: { "x-forwarded-for": "2.2.2.2" } });
    expect(other.status).toBe(400);
  });

  it("validates voice_settings", async () => {
    const app = createApp({ apiKey: "k", fetch: (async () => new Response("A")) as never });
    const post = (b: unknown) => app.request("/tts", { method: "POST", body: JSON.stringify(b), headers: { "content-type": "application/json" } });
    expect((await post({ text: "x", voice_id: "abcdefghij12", voice_settings: { stability: 2 } })).status).toBe(400);
    expect((await post({ text: "x", voice_id: "abcdefghij12", voice_settings: { stability: 0.5, similarity_boost: 0.8 } })).status).toBe(200);
  });
});


describe("default origins (no ALLOWED_ORIGINS set)", () => {
  const get = (origin?: string) => createApp().request("/config", { headers: origin ? { origin } : {} });

  it("accepts the dev web app, the extension and non-browser callers", async () => {
    expect((await get("http://localhost:5173")).status).toBe(200);
    expect((await get("http://127.0.0.1:8080")).status).toBe(200);
    expect((await get("chrome-extension://abcdefghijklmnopabcdefghijklmnop")).status).toBe(200);
    expect((await get()).status).toBe(200);
    const r = await get("chrome-extension://abcdefghijklmnopabcdefghijklmnop");
    expect(r.headers.get("access-control-allow-origin")).toBe("chrome-extension://abcdefghijklmnopabcdefghijklmnop");
  });

  it("still refuses web pages on other origins and look-alike hosts", async () => {
    expect((await get("https://evil.example")).status).toBe(403);
    expect((await get("http://localhost.evil.example")).status).toBe(403);
    expect((await get("http://localhost:80.evil.example")).status).toBe(403);
    expect((await get("https://localhost:5173")).status).toBe(403);
  });

  it("answers the preflight a browser sends before a JSON POST from the extension", async () => {
    const res = await createApp().request("/tts", { method: "OPTIONS", headers: { origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop", "access-control-request-method": "POST" } });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-headers")).toContain("content-type");
  });
});
