import type { LibraryDB } from "./store";

export const audioKey = (voiceId: string, chunkHash: string) => `${voiceId}:${chunkHash}`;

export async function getAudio(db: LibraryDB, key: string): Promise<Blob | undefined> {
  return (await db.audio.get(key))?.data;
}

/** Store audio, evicting oldest entries beyond `maxEntries` so storage stays bounded. */
export async function putAudio(db: LibraryDB, key: string, data: Blob, maxEntries = 500, now = Date.now()): Promise<void> {
  await db.audio.put({ key, data, createdAt: now });
  const extra = (await db.audio.count()) - maxEntries;
  if (extra > 0) {
    const oldest = await db.audio.orderBy("createdAt").limit(extra).primaryKeys();
    await db.audio.bulkDelete(oldest);
  }
}
