import { audioKey, getAudio, putAudio } from "./audio-cache";
import { hashText } from "./hash";
import { chunkText, toTtsRequest, type Chunk, type VoiceSettings } from "./tts";
import { withRetry } from "./retry";
import type { LibraryDB } from "./store";

const cache = new Map<string, Promise<string>>();

export interface PlayerConfig {
  db: LibraryDB;
  /** Base URL of the apps/api proxy, e.g. "/api" or "http://localhost:8787". */
  apiBase: string;
  voiceId: string;
  /** Bearer token for the API, if it is configured with API_TOKEN. */
  token?: string;
  voiceSettings?: VoiceSettings;
  /** Active TTS engine (from /config). Part of the cache key so switching engines never replays stale audio. */
  engine?: string;
}

function fetchAudio(c: Chunk, { db, apiBase, voiceId, token, voiceSettings, engine }: PlayerConfig): Promise<string> {
  // Persistent key includes voice settings: changing them must not replay audio rendered with the old ones.
  const key = audioKey(`${engine ?? ""}:${voiceSettings ? `${voiceId}~${hashText(JSON.stringify(voiceSettings))}` : voiceId}`, c.hash);
  const cacheKey = `${apiBase}|${key}`;
  let p = cache.get(cacheKey);
  if (!p) {
    p = withRetry(async () => {
      // Persistent cache first: replays and post-crash resumes cost no API characters.
      const cached = await getAudio(db, key).catch(() => undefined);
      if (cached) return URL.createObjectURL(cached);
      const r = await fetch(`${apiBase}/tts`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(toTtsRequest(c, voiceId, undefined, voiceSettings)) });
      if (r.status === 429 || r.status >= 500) throw new Error(`tts ${r.status}`);
      if (!r.ok) throw Object.assign(new Error(`tts ${r.status}`), { fatal: true });
      const blob = await r.blob();
      await putAudio(db, key, blob).catch(() => {});
      return URL.createObjectURL(blob);
    }, { retries: 6 });
    // A failed fetch must not poison the cache; the next play retries.
    p.catch(() => cache.delete(cacheKey));
    cache.set(cacheKey, p);
  }
  return p;
}

export interface Player {
  stop(): void;
}

/** Plays text chunk by chunk, prefetching the next while the current one plays. Resumes from `startAt`. */
export function narrate(
  text: string,
  cfg: PlayerConfig,
  cb: { onChunk(index: number, total: number): void; onDone(): void; onError(e: Error): void },
  startAt = 0,
): Player {
  const chunks = chunkText(text);
  let stopped = false;
  const audio = new Audio();

  const playFrom = async (i: number) => {
    if (stopped) return;
    if (i >= chunks.length) return cb.onDone();
    try {
      cb.onChunk(i, chunks.length);
      const url = await fetchAudio(chunks[i]!, cfg);
      if (chunks[i + 1]) void fetchAudio(chunks[i + 1]!, cfg).catch(() => {});
      if (stopped) return;
      audio.src = url;
      audio.onended = () => void playFrom(i + 1);
      await audio.play();
    } catch (e) {
      if (!stopped) cb.onError(e as Error);
    }
  };
  void playFrom(startAt);
  return { stop: () => { stopped = true; audio.pause(); } };
}
