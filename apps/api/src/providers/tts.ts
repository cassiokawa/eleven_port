import type { ProviderConfig } from "./config.ts";

type Fetch = typeof fetch;

export interface TtsBody {
  text: string;
  voice_id: string;
  model_id?: string;
  previous_text?: string;
  next_text?: string;
  voice_settings?: Record<string, number>;
}

export type TtsResult = { ok: true; body: ReadableStream<Uint8Array> | null; contentType: string } | { ok: false; status: number };

export async function ttsElevenLabs(f: Fetch, key: string, b: TtsBody): Promise<TtsResult> {
  const { voice_id, ...rest } = b;
  const res = await f(`https://api.elevenlabs.io/v1/text-to-speech/${voice_id}`, {
    method: "POST",
    headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" },
    body: JSON.stringify({ model_id: "eleven_multilingual_v2", ...rest }),
  });
  return res.ok ? { ok: true, body: res.body, contentType: "audio/mpeg" } : { ok: false, status: res.status };
}

const MIME: Record<string, string> = { mp3: "audio/mpeg", wav: "audio/wav", opus: "audio/ogg", flac: "audio/flac", aac: "audio/aac" };

/**
 * OpenAI-compatible speech endpoint (Kokoro-FastAPI, many Piper/XTTS wrappers).
 * previous_text / next_text / voice_settings are ElevenLabs concepts and are not sent.
 */
export async function ttsLocal(f: Fetch, cfg: ProviderConfig, b: TtsBody): Promise<TtsResult> {
  let res: Response;
  try {
    res = await f(`${cfg.localTtsUrl}/v1/audio/speech`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: cfg.localTtsModel,
        input: b.text,
        voice: cfg.localTtsVoice ?? b.voice_id,
        response_format: cfg.localTtsFormat,
      }),
    });
  } catch {
    return { ok: false, status: 503 };
  }
  if (!res.ok) return { ok: false, status: res.status };
  const upstream = res.headers.get("content-type");
  return { ok: true, body: res.body, contentType: upstream && upstream.startsWith("audio/") ? upstream : (MIME[cfg.localTtsFormat] ?? "audio/mpeg") };
}
