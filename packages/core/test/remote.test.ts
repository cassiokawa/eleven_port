import { describe, expect, it, vi } from "vitest";
import { createRemoteOcr, fetchServerConfig, type Ocr } from "../src";

const png = "data:image/png;base64,AAAA";
const ok = (text: string) => new Response(JSON.stringify({ text }));
const bundled = (text: string): { ocr: Ocr } => ({ ocr: { recognize: async () => text, terminate: async () => {} } });

describe("createRemoteOcr", () => {
  it("sends the image with the bearer token and returns the text", async () => {
    const f = vi.fn(async (_u: string | URL, _i?: RequestInit) => ok("hello"));
    const ocr = createRemoteOcr("http://api", { token: "t", fetchImpl: f as never });
    expect(await ocr.recognize(png)).toBe("hello");
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("http://api/ocr");
    expect((init!.headers as Record<string, string>).authorization).toBe("Bearer t");
    expect(JSON.parse(init!.body as string)).toEqual({ image: png });
  });

  it("falls back to the bundled engine on errors, creating it once", async () => {
    const b = bundled("from tesseract");
    let created = 0;
    const ocr = createRemoteOcr("http://api", {
      fetchImpl: (async () => new Response("", { status: 502 })) as never,
      fallback: async () => { created++; return b.ocr; },
    });
    expect(await ocr.recognize(png)).toBe("from tesseract");
    expect(await ocr.recognize(png)).toBe("from tesseract");
    expect(created).toBe(1);
  });

  it("falls back for inputs it cannot send, and throws when there is no fallback", async () => {
    const f = vi.fn();
    const withFb = createRemoteOcr("http://api", { fetchImpl: f as never, fallback: async () => bundled("fb").ocr });
    expect(await withFb.recognize(new Uint8Array([1]))).toBe("fb");
    expect(f).not.toHaveBeenCalled();
    const none = createRemoteOcr("http://api", { fetchImpl: (async () => new Response("", { status: 501 })) as never });
    await expect(none.recognize(png)).rejects.toThrow("ocr 501");
  });
});

describe("fetchServerConfig", () => {
  it("returns undefined instead of throwing when the API is down", async () => {
    expect(await fetchServerConfig("http://x", undefined, (async () => { throw new Error("down"); }) as never)).toBeUndefined();
    expect(await fetchServerConfig("http://x", undefined, (async () => new Response("", { status: 404 })) as never)).toBeUndefined();
  });
  it("parses the config", async () => {
    const cfg = { llm: "ollama", llmConfigured: true, tts: "local", ttsConfigured: true, ocr: ["tesseract"] };
    expect(await fetchServerConfig("http://x", "t", (async () => new Response(JSON.stringify(cfg))) as never)).toEqual(cfg);
  });
});
