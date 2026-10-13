import type { Block } from "../types";

interface TextItem {
  str: string;
  transform: number[];
  height: number;
}

export interface PdfPageResult {
  page: number;
  blocks: Block[];
  /** No usable text layer; caller should OCR the rendered page. */
  needsOcr: boolean;
}

interface Line {
  y: number;
  size: number;
  text: string;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}

/** Group text items into lines by baseline, then lines into blocks using size and gap heuristics. */
export function pageItemsToBlocks(items: TextItem[], bodySize?: number): { blocks: Block[]; lines: Line[] } {
  const rows = new Map<number, TextItem[]>();
  for (const it of items) {
    if (!it.str.trim()) continue;
    const y = Math.round(it.transform[5]! / 2) * 2;
    (rows.get(y) ?? rows.set(y, []).get(y)!).push(it);
  }
  const lines: Line[] = [...rows.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([y, its]) => {
      its.sort((a, b) => a.transform[4]! - b.transform[4]!);
      return {
        y,
        size: Math.max(...its.map((i) => Math.abs(i.transform[3]!) || i.height)),
        text: its.map((i) => i.str).join(" ").replace(/\s+/g, " ").trim(),
      };
    });
  if (!lines.length) return { blocks: [], lines };

  const body = bodySize ?? median(lines.map((l) => l.size));
  const lineHeight = body * 1.25;
  const blocks: Block[] = [];
  let para: string[] = [];
  let prev: Line | undefined;
  const flush = () => {
    if (para.length) blocks.push({ type: "paragraph", text: para.join(" ") });
    para = [];
  };

  for (const l of lines) {
    const ratio = l.size / body;
    if (ratio >= 1.15) {
      flush();
      blocks.push({ type: "heading", level: ratio >= 1.8 ? 1 : ratio >= 1.4 ? 2 : 3, text: l.text });
    } else {
      if (prev && prev.y - l.y > lineHeight * 1.6) flush();
      para.push(l.text);
    }
    prev = l;
  }
  flush();
  return { blocks, lines };
}

/** Extract blocks per page from PDF bytes using pdf.js (text layer). */
export async function extractPdf(data: Uint8Array): Promise<PdfPageResult[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data, useSystemFonts: true });
  const doc = await task.promise;

  const pages: { items: TextItem[] }[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    pages.push({ items: tc.items.filter((i) => "str" in i) as unknown as TextItem[] });
  }
  // Body size is document-wide so headings are judged consistently across pages.
  const sizes = pages.flatMap((pg) => pg.items.filter((i) => i.str.trim()).map((i) => Math.abs(i.transform[3]!) || i.height));
  const body = median(sizes);

  const out = pages.map((pg, i) => {
    const { blocks } = pageItemsToBlocks(pg.items, body || undefined);
    return { page: i + 1, blocks, needsOcr: blocks.length === 0 };
  });
  await task.destroy();
  return out;
}
