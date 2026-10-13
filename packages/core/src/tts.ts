export interface Chunk {
  index: number;
  text: string;
  previous: string;
  next: string;
  hash: string;
}

import { hashText } from "./hash";

/**
 * Split text into sentence-aware chunks no longer than maxChars. Sentences
 * longer than the limit are split at clause boundaries, then hard-split.
 * `previous`/`next` carry neighbouring text for ElevenLabs prosody continuity.
 */
export function chunkText(text: string, maxChars = 2500, context = 200): Chunk[] {
  const sentences = text
    .replace(/\s+/g, " ")
    .trim()
    .match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) ?? [];

  const pieces: string[] = [];
  for (const s of sentences) {
    if (s.length <= maxChars) {
      pieces.push(s);
      continue;
    }
    for (const part of s.split(/(?<=[,;:])\s+/)) {
      for (let i = 0; i < part.length; i += maxChars) pieces.push(part.slice(i, i + maxChars));
    }
  }

  const raw: string[] = [];
  let cur = "";
  for (const p of pieces) {
    if (cur && cur.length + p.length > maxChars) {
      raw.push(cur.trim());
      cur = "";
    }
    cur += p;
  }
  if (cur.trim()) raw.push(cur.trim());

  return raw.map((t, i) => ({
    index: i,
    text: t,
    previous: (raw[i - 1] ?? "").slice(-context),
    next: (raw[i + 1] ?? "").slice(0, context),
    hash: hashText(t),
  }));
}

export interface TtsRequest {
  text: string;
  previous_text?: string;
  next_text?: string;
  voice_id: string;
  model_id?: string;
}

/** Build the request body for the apps/api ElevenLabs proxy. */
export function toTtsRequest(c: Chunk, voiceId: string, modelId = "eleven_multilingual_v2"): TtsRequest {
  return { text: c.text, previous_text: c.previous || undefined, next_text: c.next || undefined, voice_id: voiceId, model_id: modelId };
}
