export type OcrSource = string | Blob | Uint8Array | HTMLCanvasElement | ImageData;

export interface Ocr {
  recognize(img: OcrSource): Promise<string>;
  terminate(): Promise<void>;
}

/** Lazily create a tesseract.js worker; one worker is reused across pages. */
export async function createOcr(lang = "eng"): Promise<Ocr> {
  const { createWorker } = await import("tesseract.js");
  const worker = await createWorker(lang);
  return {
    async recognize(img) {
      const { data } = await worker.recognize(img as never);
      return data.text;
    },
    terminate: async () => {
      await worker.terminate();
    },
  };
}

/** OCR text arrives with hard line wraps; collapse them into paragraphs. */
export function cleanOcrText(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.replace(/\n/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n\n");
}

import { parseMarkdown } from "../markdown";
import type { Block } from "../types";

/** OCR a rendered page image into blocks. */
export async function ocrToBlocks(ocr: Ocr, img: OcrSource): Promise<Block[]> {
  return parseMarkdown(cleanOcrText(await ocr.recognize(img)));
}
