import { refreshStatus, getParts } from "./library";
import type { LibraryDB } from "./store";
import type { Block, Part } from "./types";

export interface ReprocessResult {
  fixed: number;
  failed: number;
}

/**
 * Re-run extraction for parts marked failed/pending. `redo` produces blocks for
 * one part (e.g. OCR a PDF page, refetch a URL). One part failing never aborts the rest.
 */
export async function reprocessFailedParts(
  db: LibraryDB,
  itemId: string,
  redo: (part: Part) => Promise<Block[]>,
  onProgress?: (done: number, total: number) => void,
): Promise<ReprocessResult> {
  const parts = await getParts(db, itemId);
  const todo = parts.filter((p) => p.status !== "ok");
  let fixed = 0;
  let failed = 0;
  for (const [n, p] of todo.entries()) {
    try {
      const blocks = await redo(p);
      if (!blocks.length) throw new Error("no content recovered");
      await db.parts.put({ ...p, blocks, status: "ok" });
      fixed++;
    } catch {
      failed++;
    }
    onProgress?.(n + 1, todo.length);
  }
  await refreshStatus(db, itemId, parts.length);
  return { fixed, failed };
}
