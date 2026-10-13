import {
  addItem, assemblePages, buildToc, createJob, extractPdf, extractWeb, normalizeHeadings, parseMarkdown,
  createOcr, createRemoteOcr, ocrToBlocks, resumeInterrupted, refreshStatus, renderPdfPage, reprocessFailedParts, runJob, savePart, withRetry,
  type Block, type Item,
} from "@eleven-port/core";
import { apiFetch } from "./api";
import { loadSettings } from "./settings";
import { db } from "./db";

const titleFrom = (blocks: Block[], fallback: string) => blocks.find((b) => b.type === "heading")?.text ?? fallback;

/** Split blocks into parts at level-1/2 headings so each chapter is saved independently. */
export function splitParts(blocks: Block[]): { title: string; blocks: Block[] }[] {
  const norm = normalizeHeadings(blocks);
  const parts: { title: string; blocks: Block[] }[] = [];
  for (const b of norm) {
    if (b.type === "heading" && (b.level ?? 1) <= 2 && (parts.length === 0 || parts[parts.length - 1]!.blocks.length > 0)) {
      parts.push({ title: b.text, blocks: [b] });
    } else {
      if (!parts.length) parts.push({ title: "", blocks: [] });
      parts[parts.length - 1]!.blocks.push(b);
    }
  }
  return parts.length ? parts : [{ title: "", blocks: [] }];
}

async function storeBlocks(kind: Item["kind"], title: string, source: string, blocks: Block[]): Promise<Item> {
  const item = await addItem(db, { kind, title, source });
  const parts = splitParts(blocks);
  for (const [i, p] of parts.entries()) await savePart(db, item.id, i, p.title, p.blocks);
  await refreshStatus(db, item.id, parts.length);
  return item;
}

export async function ingestMarkdown(name: string, text: string): Promise<Item> {
  const blocks = parseMarkdown(text);
  return storeBlocks("note", titleFrom(blocks, name), `file:${name}`, blocks);
}

export async function ingestUrl(url: string): Promise<Item> {
  const res = await withRetry(async () => {
    const r = await apiFetch(`/fetch?url=${encodeURIComponent(url)}`);
    if (r.status >= 500 || r.status === 429) throw new Error(`fetch ${r.status}`);
    return r;
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `fetch failed (${res.status})`);
  const { body } = await res.json();
  const doc = new DOMParser().parseFromString(body, "text/html");
  const base = doc.createElement("base");
  base.href = url;
  doc.head.append(base);
  const ex = extractWeb(doc);
  if (!ex) throw new Error("no readable article found");
  return storeBlocks("article", ex.title, url, ex.blocks);
}

/** PDF pages are checkpointed as job units; a reload resumes via runJob, and one bad page does not lose the rest. */
export async function ingestPdf(name: string, data: Uint8Array, onProgress?: (d: number, t: number) => void): Promise<Item> {
  const pages = await extractPdf(data);
  const item = await addItem(db, { kind: "pdf", title: name.replace(/\.pdf$/i, ""), source: `file:${name}` });
  // Keep the original bytes so scanned/failed pages can be OCR'd or retried later, even after a reload.
  await db.blobs.put({ id: item.id, data, type: "application/pdf" });
  const job = await createJob(db, item.id, pages.length);
  await runJob(
    db,
    job.id,
    async (unit) => {
      const page = pages[unit.index]!;
      // Scanned pages need rendering to a canvas for OCR; until then they are recorded as failed gaps.
      if (page.needsOcr) throw new Error("no text layer (scanned page)");
      await savePart(db, item.id, unit.index, `Page ${page.page}`, page.blocks);
      return "ok";
    },
    { maxAttempts: 1, onProgress },
  );
  // Failed pages still get a part row so the gap is visible and retryable.
  for (const [i, p] of pages.entries()) {
    if (p.needsOcr) await savePart(db, item.id, i, `Page ${p.page}`, [], "failed");
  }
  await refreshStatus(db, item.id, pages.length);
  return item;
}

/** Re-run failed parts: OCR for PDF pages, re-fetch for URL articles. */
export async function retryFailed(item: Item, onProgress?: (d: number, t: number) => void) {
  if (item.kind === "pdf") {
    const blob = await db.blobs.get(item.id);
    if (!blob) throw new Error("original PDF not stored; re-import the file");
    const { ocrEngine, token } = loadSettings();
    // Local vision model if chosen; any failure falls back to the bundled Tesseract per page.
    const ocr = ocrEngine === "local-vision" ? createRemoteOcr("/api", { token: token || undefined, fallback: () => createOcr() }) : await createOcr();
    try {
      return await reprocessFailedParts(
        db,
        item.id,
        async (part) => ocrToBlocks(ocr, await renderPdfPage(blob.data, part.index + 1)),
        onProgress,
      );
    } finally {
      await ocr.terminate();
    }
  }
  if (item.kind === "article" && /^https?:/.test(item.source)) {
    const res = await withRetry(async () => {
      const r = await apiFetch(`/fetch?url=${encodeURIComponent(item.source)}`);
      if (r.status >= 500 || r.status === 429) throw new Error(`fetch ${r.status}`);
      return r;
    });
    if (!res.ok) throw new Error(`fetch failed (${res.status})`);
    const doc = new DOMParser().parseFromString((await res.json()).body, "text/html");
    const ex = extractWeb(doc);
    if (!ex) throw new Error("no readable article found");
    const parts = splitParts(ex.blocks);
    return reprocessFailedParts(db, item.id, async (p) => parts[p.index]?.blocks ?? [], onProgress);
  }
  throw new Error(`cannot reprocess ${item.kind} items automatically`);
}

export { assemblePages, buildToc };

/** Continue PDF jobs left mid-flight by a closed tab or crash. Call once at startup. */
export function resumePending() {
  return resumeInterrupted(db, async (item) => {
    if (item.kind !== "pdf") return undefined;
    const blob = await db.blobs.get(item.id);
    if (!blob) return undefined;
    const pages = await extractPdf(blob.data);
    return async (unit) => {
      const page = pages[unit.index]!;
      if (page.needsOcr) throw new Error("no text layer (scanned page)");
      await savePart(db, item.id, unit.index, `Page ${page.page}`, page.blocks);
      return "ok";
    };
  });
}
