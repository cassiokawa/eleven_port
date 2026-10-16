import { readConfig, type ProviderConfig } from "./providers/config.ts";

export type Level = "pass" | "fail" | "warn" | "skip";
export interface Check {
  name: string;
  level: Level;
  detail: string;
}

type Fetch = typeof fetch;

const check = (name: string, level: Level, detail: string): Check => ({ name, level, detail });

async function json<T>(f: Fetch, url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: T | undefined }> {
  const r = await f(url, init);
  return { ok: r.ok, status: r.status, body: (await r.json().catch(() => undefined)) as T | undefined };
}

/** Is a configured tag present in `ollama list`? Ollama treats `name` as `name:latest`. */
const hasModel = (names: string[], want: string) => names.includes(want) || (!want.includes(":") && names.includes(`${want}:latest`));

async function ollamaChecks(f: Fetch, cfg: ProviderConfig): Promise<Check[]> {
  const out: Check[] = [];
  const wanted = [
    ["suggestion model", cfg.llm === "ollama" ? cfg.ollamaModel : undefined, false],
    ["vision model", cfg.ollamaVisionModel, true],
  ] as const;
  if (cfg.llm !== "ollama" && !cfg.ollamaVisionModel) return [check("ollama", "skip", "not used (LLM_PROVIDER is not ollama and no OLLAMA_VISION_MODEL)")];

  let names: string[];
  try {
    const r = await json<{ models?: { name: string }[] }>(f, `${cfg.ollamaUrl}/api/tags`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    names = (r.body?.models ?? []).map((m) => m.name);
    out.push(check("ollama reachable", "pass", `${cfg.ollamaUrl} (${names.length} models installed)`));
  } catch (e) {
    return [check("ollama reachable", "fail", `${cfg.ollamaUrl}: ${(e as Error).message}. Is Ollama running?`)];
  }

  for (const [label, model, needsVision] of wanted) {
    if (!model) {
      if (label === "suggestion model" && cfg.llm === "ollama") out.push(check(label, "fail", "OLLAMA_MODEL is not set"));
      continue;
    }
    if (!hasModel(names, model)) {
      out.push(check(label, "fail", `${model} is not installed. Run: ollama pull ${model}`));
      continue;
    }
    if (needsVision) {
      const r = await json<{ capabilities?: string[] }>(f, `${cfg.ollamaUrl}/api/show`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model }) }).catch(() => undefined);
      const caps = r?.body?.capabilities;
      if (!caps) out.push(check(label, "warn", `${model} installed; could not read capabilities (older Ollama?). Check: ollama show ${model}`));
      else if (!caps.includes("vision")) out.push(check(label, "fail", `${model} has no vision capability (has: ${caps.join(", ")})`));
      else out.push(check(label, "pass", `${model} installed, vision supported`));
    } else {
      out.push(check(label, "pass", `${model} installed`));
    }
  }
  return out;
}

function voiceName(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    for (const k of ["name", "id", "voice_id", "voice"]) if (typeof o[k] === "string") return o[k] as string;
  }
  return undefined;
}

const preview = (names: string[], n: number) => names.slice(0, n).join(", ") + (names.length > n ? ", ..." : "");

async function ttsChecks(f: Fetch, cfg: ProviderConfig): Promise<Check[]> {
  if (cfg.tts !== "local") return [check("local tts", "skip", "TTS_PROVIDER is not local")];
  if (!cfg.localTtsUrl) return [check("local tts", "fail", "LOCAL_TTS_URL is not set (Kokoro-FastAPI listens on http://localhost:8880)")];
  const out: Check[] = [];

  // The voices listing is a Kokoro-FastAPI extension, not part of the OpenAI API, and its entries may be names
  // or objects, so this is informational only. The synthesis check below is what proves the voice works.
  try {
    const r = await json<{ voices?: unknown[] }>(f, `${cfg.localTtsUrl}/v1/audio/voices`);
    const names = r.ok && Array.isArray(r.body?.voices) ? r.body.voices.map(voiceName).filter((n): n is string => !!n) : [];
    if (!names.length) {
      out.push(check("tts voice", "warn", "server did not list voices in a known format; relying on the synthesis check"));
    } else if (!cfg.localTtsVoice) {
      out.push(check("tts voice", "warn", `LOCAL_TTS_VOICE not set; the web app's voice field will be used. Available: ${preview(names, 8)}`));
    } else if (names.includes(cfg.localTtsVoice)) {
      out.push(check("tts voice", "pass", `${cfg.localTtsVoice} is listed`));
    } else {
      out.push(check("tts voice", "warn", `"${cfg.localTtsVoice}" is not in the server's list. Available: ${preview(names, 12)}`));
    }
  } catch {
    /* reachability is judged by the synthesis call below */
  }

  try {
    const res = await f(`${cfg.localTtsUrl}/v1/audio/speech`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: cfg.localTtsModel, input: "Local narration is working.", voice: cfg.localTtsVoice ?? "af_bella", response_format: cfg.localTtsFormat }),
    });
    const bytes = new Uint8Array(await res.arrayBuffer());
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok) out.push(check("local tts synthesis", "fail", `HTTP ${res.status} from ${cfg.localTtsUrl}/v1/audio/speech`));
    else if (bytes.length < 1000) out.push(check("local tts synthesis", "fail", `only ${bytes.length} bytes returned; expected audio`));
    else out.push(check("local tts synthesis", "pass", `${bytes.length} bytes of ${type || "audio"}`));
  } catch (e) {
    out.push(check("local tts synthesis", "fail", `${cfg.localTtsUrl} unreachable: ${(e as Error).message}. Is the TTS server running?`));
  }
  return out;
}

/** Verify a local-model setup end to end without starting the API. */
export async function runDoctor(env: Record<string, string | undefined> = process.env, f: Fetch = fetch): Promise<Check[]> {
  const cfg = readConfig(env);
  return [...(await ollamaChecks(f, cfg)), ...(await ttsChecks(f, cfg))];
}

export const failed = (checks: Check[]) => checks.some((c) => c.level === "fail");
