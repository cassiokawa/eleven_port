import { createOcr, type Ocr } from "@eleven-port/core";

let shared: Promise<Ocr> | undefined;

/** One OCR worker for the panel's lifetime, loaded from bundled extension assets (works offline). */
export function getOcr(): Promise<Ocr> {
  shared ??= createOcr("eng", {
    workerPath: chrome.runtime.getURL("ocr/worker.min.js"),
    corePath: chrome.runtime.getURL("ocr"),
    langPath: chrome.runtime.getURL("ocr"),
  });
  return shared;
}
