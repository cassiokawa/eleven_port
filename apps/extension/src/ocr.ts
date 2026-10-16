import { createOcr, createRemoteOcr, type Ocr } from "@eleven-port/core";

export type OcrEngine = "tesseract" | "local-vision";

let bundled: Promise<Ocr> | undefined;

/** The bundled Tesseract worker: one per panel lifetime, loaded from extension assets (works offline). */
export function getBundledOcr(): Promise<Ocr> {
  bundled ??= createOcr("eng", {
    workerPath: chrome.runtime.getURL("ocr/worker.min.js"),
    corePath: chrome.runtime.getURL("ocr"),
    langPath: chrome.runtime.getURL("ocr"),
  });
  return bundled;
}

/** Local vision model through the API when selected; any failure falls back to the bundled engine per page. */
export function getOcr(engine: OcrEngine, apiBase: string, token?: string): Promise<Ocr> {
  if (engine !== "local-vision") return getBundledOcr();
  return Promise.resolve(createRemoteOcr(apiBase, { token, fallback: getBundledOcr }));
}
