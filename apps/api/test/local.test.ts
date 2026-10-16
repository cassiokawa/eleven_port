import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.ts";
import { SCHEMA } from "../src/suggest.ts";

const json = (b: unknown) => ({ method: "POST", body: JSON.stringify(b), headers: { "content-type": "application/json" } });
const chatReply = (content: string) => new Response(JSON.stringify({ message: { content } }));

function make(over: Record<string, unknown>, handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test helper reads arbitrary request JSON
  const calls: { url: string; body: Record<string, any> | undefined }[] = [];
  const f = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    const u = String(url);
    calls.push({ url: u, body: typeof init.body === "string" ? JSON.parse(init.body) : undefined });
    return handler(u, init);
  });
  const app = createApp({ fetch: f as never, config: { ollamaUrl: "http://ollama.test", ...over } });
  return { app, calls };
}

describe("local LLM (Ollama) suggestions", () => {
  const input = { title: "Quantum", excerpt: "e", vocabulary: ["Physics"], headings: ["A"] };

  it("sends the schema as `format`, sanitizes output, and never contacts a cloud API", async () => {
    const { app, calls } = make({ llm: "ollama", ollamaModel: "llama3.1" }, () =>
      chatReply(JSON.stringify({ tags: ["physics", "quantum"], collection: "Science", summary: "s" })),
    );
    const res = await app.request("/suggest", json(input));
    expect(res.status).toBe(200);
    expect((await res.json()).tags).toEqual(["Physics", "quantum"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://ollama.test/api/chat");
    expect(calls[0]!.body).toMatchObject({ model: "llama3.1", stream: false, format: SCHEMA, options: { temperature: 0 } });
    expect(calls.every((c) => !/anthropic|elevenlabs/.test(c.url))).toBe(true);
  });

  it("retries once on invalid JSON, then succeeds", async () => {
    let n = 0;
    const { app, calls } = make({ llm: "ollama", ollamaModel: "m" }, () => chatReply(++n === 1 ? "sure! here you go" : JSON.stringify({ tags: ["a"], collection: "", summary: "" })));
    const res = await app.request("/suggest", json(input));
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it("returns 502 after two invalid responses and when the server is down", async () => {
    const bad = make({ llm: "ollama", ollamaModel: "m" }, () => chatReply("nope"));
    expect((await bad.app.request("/suggest", json(input))).status).toBe(502);
    const down = make({ llm: "ollama", ollamaModel: "m" }, () => {
      throw new TypeError("fetch failed");
    });
    const r = await down.app.request("/suggest", json(input));
    expect(r.status).toBe(502);
    expect((await r.json()).error).toContain("Ollama unreachable");
  });

  it("501 when no model is configured", async () => {
    const { app } = make({ llm: "ollama" }, () => chatReply("{}"));
    expect((await app.request("/suggest", json(input))).status).toBe(501);
  });
});

describe("local vision OCR", () => {
  const png = "data:image/png;base64,iVBORw0KGgo=";

  it("passes the image to the vision model and returns trimmed text", async () => {
    const { app, calls } = make({ ollamaVisionModel: "llava" }, () => chatReply("  # Chapter\n\nHello  \n"));
    const res = await app.request("/ocr", json({ image: png }));
    expect(await res.json()).toEqual({ text: "# Chapter\n\nHello" });
    expect(calls[0]!.body!.model).toBe("llava");
    expect(calls[0]!.body!.messages[0].images).toEqual(["iVBORw0KGgo="]);
  });

  it("validates input, caps size, and reports an unconfigured model", async () => {
    const { app } = make({ ollamaVisionModel: "llava" }, () => chatReply("x"));
    expect((await app.request("/ocr", json({ image: "http://x/y.png" }))).status).toBe(400);
    expect((await app.request("/ocr", json({}))).status).toBe(400);
    const huge = "data:image/png;base64," + "A".repeat(9 * 1024 * 1024);
    expect((await app.request("/ocr", json({ image: huge }))).status).toBe(413);
    const none = make({}, () => chatReply("x"));
    expect((await none.app.request("/ocr", json({ image: png }))).status).toBe(501);
  });
});

describe("local TTS", () => {
  const body = { text: "Hello there.", voice_id: "ignored_voice", previous_text: "before", next_text: "after", voice_settings: { stability: 0.5 } };

  it("calls the OpenAI-compatible endpoint, drops ElevenLabs-only fields and keeps the audio type", async () => {
    const { app, calls } = make({ tts: "local", localTtsUrl: "http://tts.test", localTtsVoice: "af_bella", localTtsFormat: "wav" }, () =>
      new Response("RIFF", { headers: { "content-type": "audio/wav" } }),
    );
    const res = await app.request("/tts", json(body));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/wav");
    expect(await res.text()).toBe("RIFF");
    expect(calls[0]!.url).toBe("http://tts.test/v1/audio/speech");
    expect(calls[0]!.body).toEqual({ model: "kokoro", input: "Hello there.", voice: "af_bella", response_format: "wav" });
    expect(calls.every((c) => !/elevenlabs/.test(c.url))).toBe(true);
  });

  it("falls back to the client voice, validates it, and maps failures", async () => {
    const ok = make({ tts: "local", localTtsUrl: "http://tts.test" }, () => new Response("A"));
    const r = await ok.app.request("/tts", json({ text: "x", voice_id: "af_sky" }));
    expect(ok.calls[0]!.body!.voice).toBe("af_sky");
    expect(r.headers.get("content-type")).toBe("audio/mpeg");
    expect((await ok.app.request("/tts", json({ text: "x", voice_id: "../etc" }))).status).toBe(400);

    const down = make({ tts: "local", localTtsUrl: "http://tts.test" }, () => {
      throw new TypeError("fetch failed");
    });
    expect((await down.app.request("/tts", json({ text: "x", voice_id: "af_sky" }))).status).toBe(502);
    const missing = make({ tts: "local" }, () => new Response("A"));
    expect((await missing.app.request("/tts", json({ text: "x", voice_id: "af_sky" }))).status).toBe(500);
  });
});

describe("/config", () => {
  it("reports active engines without secrets", async () => {
    const { app } = make({ llm: "ollama", ollamaModel: "m", tts: "local", localTtsUrl: "http://t", ollamaVisionModel: "v" }, () => new Response(""));
    const j = await (await app.request("/config")).json();
    expect(j).toEqual({ llm: "ollama", llmConfigured: true, tts: "local", ttsConfigured: true, ocr: ["tesseract", "local-vision"] });
  });
});
