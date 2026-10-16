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
  /** Advance the reader one page using turn method `method` (0 = primary, then fallbacks). */
  turn(method: number): Promise<void>;
  /**
   * Small grayscale thumbnail of an image (e.g. 64x64 luminance). Optional: it lets the engine
   * notice that the screen is still moving, or has not changed at all, without paying for OCR.
   */
  fingerprint?(img: I): Promise<Uint8Array>;
  sleep(ms: number): Promise<void>;
  signal?: AbortSignal;
}

export interface CaptureOptions {
  maxPages?: number;
  /** Base wait after a page turn; jittered up to +50% to avoid a mechanical rhythm. */
  settleMs?: number;
  /** How many different turn methods `deps.turn` understands. */
  turnMethods?: number;
  /** How many times to run through all turn methods before giving up. */
  turnRounds?: number;
  /**
   * Extra, progressively longer waits after a turn before concluding it failed. A slow render must not
   * be mistaken for a failed turn, because re-turning would then skip a page.
   */
  patience?: number;
  /** Text on the last page that means the book really ended (as opposed to a stuck turn). */
  endHint?: RegExp;
  /** Rebuild readable parts every N pages so partial progress is browsable. */
  assembleEvery?: number;
  ocrAttempts?: number;
  onProgress?: (pages: number) => void;
  random?: () => number;
}

/**
 * done: reached the end (end-of-book text seen).
 * stalled: the page would not change after every turn method and round; end of book or a blocked reader. Progress is kept.
 * paused: aborted by the caller. needs-reposition: resumed on a page other than the last saved one.
 */
export type CaptureState = "done" | "paused" | "needs-reposition" | "stalled";

export interface CaptureResult {
  state: CaptureState;
  pages: number;
  /** Page numbers (1-based) whose OCR failed and were replaced by a gap marker. */
  gaps: number[];
  /** Pages that needed more than one turn attempt. */
  retried: number;
}

/**
 * End-of-book screens, matched as whole lines so ordinary prose ("at the end of the day") never triggers it.
 * A match only shortens the retry ladder to one probe turn; it never ends capture by itself.
 */
export const END_HINT = /^\s*(the end|end of (the )?(book|sample|preview)|you(?:'ve| have) reached the end[^\n]*|before you go|rate this book)\s*[.!]?\s*$/im;

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

/** Fraction of thumbnail cells that differ noticeably (>16/255). 0 = identical frames. */
export function fingerprintDistance(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length || !a.length) return 1;
  let diff = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i]! - b[i]!) > 16) diff++;
  return diff / a.length;
}

/** Two frames this close are the same picture: the screen has stopped moving, or nothing happened. */
const IDENTICAL = 0.0005;

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

interface Frame<I> {
  img: I;
  /** Page text, or the gap marker when OCR failed. */
  text: string;
  unreadable: boolean;
  fp?: Uint8Array;
}

/**
 * Capture a paged source (e.g. Kindle Cloud Reader) page by page, verifying every page turn.
 *
 * A turn counts as successful only when the screen settled on a picture that differs from the previous
 * page and its OCR text is a different page. If it does not, the engine waits progressively longer before
 * concluding the turn failed (so a slow render never triggers a second turn that would skip a page), then
 * tries the next turn method. When every method in every round fails it stops with `stalled` unless the
 * last page carries an end-of-book hint.
 *
 * Every page is checkpointed before the next turn, so a crash or dropout loses at most the page in flight.
 * Calling again for the same item resumes: the screen must show the last saved page (by text similarity)
 * or it returns needs-reposition.
 */
export async function captureBook<I>(
  db: LibraryDB,
  itemId: string,
  deps: PageCaptureDeps<I>,
  opts: CaptureOptions = {},
): Promise<CaptureResult> {
  const {
    maxPages = 3000, settleMs = 800, turnMethods = 1, turnRounds = 2, patience = 2,
    assembleEvery = 10, ocrAttempts = 2, random = Math.random, endHint = END_HINT,
  } = opts;
  const job = await createJobOpen(db, itemId);
  const gaps: number[] = [];
  let retried = 0;
  const existing = await pageUnits(db, job.id);
  let next = existing.length;
  const aborted = () => !!deps.signal?.aborted;

  const finish = async (state: CaptureState): Promise<CaptureResult> => {
    await db.jobs.update(job.id, { state: state === "done" ? "done" : "paused", updatedAt: Date.now() });
    await assembleCaptured(db, itemId, job.id, state === "done");
    return { state, pages: next, gaps, retried };
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

  /** Capture until two consecutive frames match, so a page-curl or fade animation is never read mid-flight. */
  const settle = async (): Promise<{ img: I; fp?: Uint8Array }> => {
    let img = await deps.capture();
    if (!deps.fingerprint) return { img };
    let fp = await deps.fingerprint(img);
    for (let i = 0; i < 3; i++) {
      await deps.sleep(Math.round(settleMs * 0.4));
      const img2 = await deps.capture();
      const fp2 = await deps.fingerprint(img2);
      const stable = fingerprintDistance(fp, fp2) <= IDENTICAL;
      img = img2;
      fp = fp2;
      if (stable) break;
    }
    return { img, fp };
  };

  const toFrame = async (img: I, fp?: Uint8Array): Promise<Frame<I>> => {
    const text = await read(img);
    return { img, fp, text: text ?? GAP_MARKER(next + 1), unreadable: text === undefined };
  };

  type Advance = { frame: Frame<I>; method: number; attempts: number } | "aborted" | undefined;
  const advance = async (cur: Frame<I>): Promise<Advance> => {
    let attempts = 0;
    // On an end-of-book page one patient probe is enough; the full ladder would only burn time.
    const probe = endHint.test(cur.text);
    const rounds = probe ? 1 : turnRounds;
    const methods = probe ? 1 : turnMethods;
    const waits = probe ? Math.min(patience, 1) : patience;
    for (let round = 0; round < rounds; round++) {
      for (let method = 0; method < methods; method++) {
        if (aborted()) return "aborted";
        attempts++;
        await deps.turn(method);
        for (let wait = 0; wait <= waits; wait++) {
          // Each wait is longer than the last; only after all of them is the turn declared failed.
          await deps.sleep(Math.round(settleMs * (1 + random() * 0.5) * (wait + 1)));
          if (aborted()) return "aborted";
          const s = await settle();
          // Pixel-identical to the previous page: nothing has happened yet, no need to OCR.
          if (cur.fp && s.fp && fingerprintDistance(cur.fp, s.fp) <= IDENTICAL) continue;
          const frame = await toFrame(s.img, s.fp);
          // The picture changed but it is still the same page (cursor, toolbar, selection): not a turn.
          if (!frame.unreadable && sameText(frame.text, cur.text)) continue;
          return { frame, method, attempts };
        }
      }
    }
    return undefined;
  };

  await db.jobs.update(job.id, { state: "capturing", updatedAt: Date.now() });

  const first = await settle();
  let cur = await toFrame(first.img, first.fp);
  let save = true;

  if (existing.length) {
    // Resuming: confirm the reader is still on the last page we saved.
    const last = existing[existing.length - 1]!.payload ?? "";
    if (cur.unreadable || !sameText(cur.text, last)) return finish("needs-reposition");
    save = false;
  }

  let meta: Unit["meta"];
  for (;;) {
    if (save) {
      const page = next + 1;
      if (cur.unreadable) gaps.push(page);
      if (meta && meta.attempts > 1) retried++;
      await db.units.put({
        id: `${job.id}:${next}`, jobId: job.id, index: next,
        status: cur.unreadable ? "failed" : "done", attempts: 1, payload: cur.text, ...(meta ? { meta } : {}),
      });
      next++;
      opts.onProgress?.(next);
      if (next % assembleEvery === 0) await assembleCaptured(db, itemId, job.id, false);
    }
    save = true;
    if (next >= maxPages) return finish("done");
    if (aborted()) return finish("paused");

    const adv = await advance(cur);
    if (adv === "aborted") return finish("paused");
    if (!adv) return finish(endHint.test(cur.text) ? "done" : "stalled");
    meta = { method: adv.method, attempts: adv.attempts };
    cur = adv.frame;
  }
}
