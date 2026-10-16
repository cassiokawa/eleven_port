export type LlmProvider = "anthropic" | "ollama";
export type TtsProvider = "elevenlabs" | "local";

export interface ProviderConfig {
  llm: LlmProvider;
  tts: TtsProvider;
  ollamaUrl: string;
  ollamaModel?: string;
  ollamaVisionModel?: string;
  localTtsUrl?: string;
  localTtsModel: string;
  /** Overrides the client-sent voice; local engines do not know ElevenLabs voice ids. */
  localTtsVoice?: string;
  localTtsFormat: string;
}

const pick = <T extends string>(v: string | undefined, allowed: readonly T[], fallback: T): T =>
  allowed.includes(v as T) ? (v as T) : fallback;

export function readConfig(env: Record<string, string | undefined> = process.env): ProviderConfig {
  return {
    llm: pick(env.LLM_PROVIDER, ["anthropic", "ollama"] as const, "anthropic"),
    tts: pick(env.TTS_PROVIDER, ["elevenlabs", "local"] as const, "elevenlabs"),
    ollamaUrl: (env.OLLAMA_URL || "http://localhost:11434").replace(/\/+$/, ""),
    ollamaModel: env.OLLAMA_MODEL || undefined,
    ollamaVisionModel: env.OLLAMA_VISION_MODEL || undefined,
    localTtsUrl: env.LOCAL_TTS_URL?.replace(/\/+$/, "") || undefined,
    localTtsModel: env.LOCAL_TTS_MODEL || "kokoro",
    localTtsVoice: env.LOCAL_TTS_VOICE || undefined,
    localTtsFormat: env.LOCAL_TTS_FORMAT || "mp3",
  };
}
