import { audioKey, chunkText, getAudio, putAudio, toTtsRequest, withRetry, type Chunk } from "@eleven-port/core";
import { db } from "./db";

const cache = new Map<string, Promise<string>>();

function fetchAudio(c: Chunk, voiceId: string): Promise<string> {
  const key = audioKey(voiceId, c.hash);
  let p = cache.get(key);
  if (!p) {
    p = withRetry(async () => {
      // Persistent cache first: replays and post-crash resumes cost no API characters.
      const cached = await getAudio(db, key).catch(() => undefined);
      if (cached) return URL.createObjectURL(cached);
      const r = await fetch("/api/tts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(toTtsRequest(c, voiceId)) });
      if (r.status === 429 || r.status >= 500) throw new Error(`tts ${r.status}`);
      if (!r.ok) throw Object.assign(new Error(`tts ${r.status}`), { fatal: true });
      const blob = await r.blob();
      await putAudio(db, key, blob).catch(() => {});
      return URL.createObjectURL(blob);
    }, { retries: 6 });
    // A failed fetch must not poison the cache; the next play retries.
    p.catch(() => cache.delete(key));
    cache.set(key, p);
  }
  return p;
}

export interface Player {
  stop(): void;
}

/** Plays text chunk by chunk, prefetching the next while the current one plays. Resumes from `startAt`. */
export function narrate(
  text: string,
  voiceId: string,
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
      const url = await fetchAudio(chunks[i]!, voiceId);
      if (chunks[i + 1]) void fetchAudio(chunks[i + 1]!, voiceId).catch(() => {});
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
