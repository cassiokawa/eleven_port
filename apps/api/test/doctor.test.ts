import { describe, expect, it } from "vitest";
import { failed, runDoctor } from "../src/doctor.ts";

const j = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

function fake(opts: { models?: string[]; caps?: string[]; voices?: string[]; audioBytes?: number; ollamaDown?: boolean; ttsDown?: boolean }) {
  return (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith("http://ollama")) {
      if (opts.ollamaDown) throw new TypeError("fetch failed");
      if (u.endsWith("/api/tags")) return j({ models: (opts.models ?? []).map((name) => ({ name })) });
      if (u.endsWith("/api/show")) return opts.caps ? j({ capabilities: opts.caps }) : j({});
    }
    if (u.startsWith("http://tts")) {
      if (opts.ttsDown) throw new TypeError("fetch failed");
      if (u.endsWith("/v1/audio/voices")) return opts.voices ? j({ voices: opts.voices }) : new Response("", { status: 404 });
      if (u.endsWith("/v1/audio/speech")) {
        JSON.parse(String(init?.body));
        return new Response(new Uint8Array(opts.audioBytes ?? 5000), { headers: { "content-type": "audio/mpeg" } });
      }
    }
    return new Response("", { status: 404 });
  }) as unknown as typeof fetch;
}

const env = {
  LLM_PROVIDER: "ollama", OLLAMA_URL: "http://ollama", OLLAMA_MODEL: "gemma4:12b", OLLAMA_VISION_MODEL: "gemma4:12b",
  TTS_PROVIDER: "local", LOCAL_TTS_URL: "http://tts", LOCAL_TTS_VOICE: "af_bella",
};
const by = (cs: Awaited<ReturnType<typeof runDoctor>>, name: string) => cs.find((c) => c.name === name)!;

describe("doctor", () => {
  it("passes a healthy all-local setup", async () => {
    const cs = await runDoctor(env, fake({ models: ["gemma4:12b"], caps: ["completion", "vision"], voices: ["af_bella", "af_sky"] }));
    expect(failed(cs)).toBe(false);
    expect(by(cs, "vision model").level).toBe("pass");
    expect(by(cs, "tts voice").level).toBe("pass");
    expect(by(cs, "local tts synthesis").level).toBe("pass");
  });

  it("flags a missing model with the pull command and a non-vision model", async () => {
    const missing = await runDoctor(env, fake({ models: ["qwen2.5:7b"], voices: ["af_bella"] }));
    expect(by(missing, "suggestion model").detail).toContain("ollama pull gemma4:12b");
    const text = await runDoctor(env, fake({ models: ["gemma4:12b"], caps: ["completion"], voices: ["af_bella"] }));
    expect(by(text, "vision model")).toMatchObject({ level: "fail" });
    expect(by(text, "vision model").detail).toContain("no vision capability");
  });

  it("reports unreachable servers instead of throwing", async () => {
    const cs = await runDoctor(env, fake({ ollamaDown: true, ttsDown: true }));
    expect(by(cs, "ollama reachable").level).toBe("fail");
    expect(by(cs, "local tts synthesis").level).toBe("fail");
    expect(failed(cs)).toBe(true);
  });

  it("rejects an unknown voice and tiny audio; tolerates a server without a voices list", async () => {
    const badVoice = await runDoctor(env, fake({ models: ["gemma4:12b"], caps: ["vision"], voices: ["af_sky"] }));
    expect(by(badVoice, "tts voice").level).toBe("fail");
    const tiny = await runDoctor(env, fake({ models: ["gemma4:12b"], caps: ["vision"], audioBytes: 10 }));
    expect(by(tiny, "local tts synthesis").level).toBe("fail");
    const noList = await runDoctor(env, fake({ models: ["gemma4:12b"], caps: ["vision"] }));
    expect(by(noList, "tts voice").level).toBe("warn");
    expect(failed(noList)).toBe(false);
  });

  it("skips components that are not in use", async () => {
    const cs = await runDoctor({}, fake({}));
    expect(cs.map((c) => c.level)).toEqual(["skip", "skip"]);
  });
});
