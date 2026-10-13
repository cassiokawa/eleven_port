import { joinPages } from "./assemble";
import { createJobOpen } from "./jobs";
import { savePart, refreshStatus } from "./library";
import { parseMarkdown } from "./markdown";
import { normalizeHeadings } from "./organize";
import type { LibraryDB } from "./store";
import type { Block, Unit } from "./types";

export interface PageCaptureDeps<I> {
  /** Grab the currently visible page as an image. */
  capture(): Promise<I>;
  /** OCR an image into text. */
  ocr(img: I): Promise<string>;
  /** Advance the reader by one page. */
  turn(): Promise<void>;
  sleep(ms: number): Promise<void>;
  signal?: AbortSignal;
}

export interface CaptureOptions {
  maxPages?: number;
  /** Delay after a page turn before capturing; jittered up to +50% to avoid hammering the reader. */
  settleMs?: number;
  /** Consecutive identical pages that mean "end of book". */
  endRepeats?: number;
  /** Rebuild readable parts every N pages so partial progress is browsable. */
  assembleEvery?: number;
  ocrAttempts?: number;
  onProgress?: (pages: number) => void;
  random?: () => number;
}

export type CaptureState = "done" | "paused" | "needs-reposition";

export interface CaptureResult {
  state: CaptureState;
  pages: number;
  /** Page numbers (1-based) whose OCR failed and were replaced by a gap marker. */
  gaps: number[];
}

const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Token-set Jaccard; robust to small OCR noise between two captures of the same page. */
export function sameText(a: string, b: string, threshold = 0.9): boolean {
  const A = new Set(norm(a).split(" ").filter(Boolean));
  const B = new Set(norm(b).split(" ").filter(Boolean));
  if (!A.size && !B.size) return true;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter) >= threshold;
}

export const GAP_MARKER = (page: number) => `*[page ${page}: text could not be read]*`;

async function pageUnits(db: LibraryDB, jobId: string): Promise<Unit[]> {
  return db.units.where("jobId").equals(jobId).sortBy("index");
}

/** Rebuild the item's parts from all captured pages so far (idempotent). */
export async function assembleCaptured(db: LibraryDB, itemId: string, jobId: string, complete: boolean): Promise<number> {
  const units = await pageUnits(db, jobId);
  const text = joinPages(units.map((u) => u.payload ?? ""));
  const blocks = normalizeHeadings(parseMarkdown(text));
  const parts: { title: string; blocks: Block[] }[] = [];
  for (const b of blocks) {
    if (b.type === "heading" && (b.level ?? 1) <= 2 && (!parts.length || parts[parts.length - 1]!.blocks.length)) {
      parts.push({ title: b.text, blocks: [b] });
    } else {
      if (!parts.length) parts.push({ title: "", blocks: [] });
      parts[parts.length - 1]!.blocks.push(b);
    }
  }
  if (!parts.length) return 0;
  const stale = (await db.parts.where("itemId").equals(itemId).toArray()).filter((p) => p.index >= parts.length);
  await db.parts.bulkDelete(stale.map((p) => p.id));
  for (const [i, p] of parts.entries()) await savePart(db, itemId, i, p.title, p.blocks);
  await refreshStatus(db, itemId, complete ? parts.length : parts.length + 1);
  return parts.length;
}

/**
 * Capture a paged source (e.g. Kindle Cloud Reader) page by page. Every page is
 * checkpointed as a Unit before the next turn, so a crash or dropout loses at most
 * the page in flight. Calling again for the same item resumes: the screen must show
 * the last captured page (checked by text similarity) or it returns needs-reposition.
 */
export async function captureBook<I>(
  db: LibraryDB,
  itemId: string,
  deps: PageCaptureDeps<I>,
  opts: CaptureOptions = {},
): Promise<CaptureResult> {
  const { maxPages = 3000, settleMs = 800, endRepeats = 2, assembleEvery = 10, ocrAttempts = 2, random = Math.random } = opts;
  const job = await createJobOpen(db, itemId);
  const gaps: number[] = [];
  const existing = await pageUnits(db, job.id);
  let next = existing.length;
  let prevText = existing[existing.length - 1]?.payload;
  const finish = async (state: CaptureState): Promise<CaptureResult> => {
    await db.jobs.update(job.id, { state: state === "done" ? "done" : "paused", updatedAt: Date.now() });
    await assembleCaptured(db, itemId, job.id, state === "done");
    return { state, pages: next, gaps };
  };

  const read = async (img: I): Promise<string | undefined> => {
    for (let a = 0; a < ocrAttempts; a++) {
      try {
        return await deps.ocr(img);
      } catch {
        /* retry */
      }
    }
    return undefined;
  };

  await db.jobs.update(job.id, { state: "capturing", updatedAt: Date.now() });

  if (prevText !== undefined) {
    // Resuming: confirm the reader is still on the last page we saved.
    const now = await read(await deps.capture());
    if (now === undefined || !sameText(now, prevText)) return finish("needs-reposition");
    await deps.turn();
    await deps.sleep(settleMs);
  }

  let repeats = 0;
  while (next < maxPages) {
    if (deps.signal?.aborted) return finish("paused");
    const img = await deps.capture();
    const text = await read(img);
    if (text !== undefined && prevText !== undefined && sameText(text, prevText)) {
      // Reader did not advance: either the turn is still settling or we reached the end.
      if (++repeats >= endRepeats) return finish("done");
      await deps.turn();
      await deps.sleep(settleMs);
      continue;
    }
    repeats = 0;
    const page = next + 1;
    if (text === undefined) gaps.push(page);
    const payload = text === undefined ? GAP_MARKER(page) : text;
    await db.units.put({ id: `${job.id}:${next}`, jobId: job.id, index: next, status: text === undefined ? "failed" : "done", attempts: 1, payload });
    prevText = payload;
    next++;
    opts.onProgress?.(next);
    if (next % assembleEvery === 0) await assembleCaptured(db, itemId, job.id, false);

    await deps.turn();
    await deps.sleep(Math.round(settleMs * (1 + random() * 0.5)));
  }
  return finish("done");
}
