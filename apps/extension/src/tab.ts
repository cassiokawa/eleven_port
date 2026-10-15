import type { Block } from "@eleven-port/core";

export interface WebCapture {
  ok: boolean;
  error?: string;
  title?: string;
  author?: string;
  url?: string;
  blocks?: Block[];
}

/** E2E hook: when the panel is opened as a plain tab with ?targetTab=<id>, act on that tab instead of the active one. */
const forcedTab = Number(new URLSearchParams(location.search).get("targetTab")) || undefined;

export async function activeTab(): Promise<chrome.tabs.Tab> {
  if (forcedTab) return chrome.tabs.get(forcedTab);
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) throw new Error("no active tab");
  return tab;
}

/** Inject the content script and ask it to extract the article from the live DOM. */
export async function extractFromTab(tabId: number): Promise<WebCapture> {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  return chrome.tabs.sendMessage(tabId, { type: "extract" });
}

// Chrome allows only about two captureVisibleTab calls per second; going over throws a quota error.
const MIN_SHOT_GAP_MS = 600;
let lastShot = 0;

export async function screenshot(windowId: number): Promise<string> {
  const wait = lastShot + MIN_SHOT_GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  // captureVisibleTab only sees the active tab; in the E2E hook the panel is itself a tab, so bring the target forward.
  if (forcedTab) await chrome.tabs.update(forcedTab, { active: true });
  try {
    return await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
  } finally {
    lastShot = Date.now();
  }
}

export interface Crop {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** Crop browser/reader chrome (toolbars, page counters) out of a screenshot so it does not pollute OCR. Fractions of size. */
export async function cropDataUrl(dataUrl: string, c: Crop): Promise<string> {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const x = Math.round(img.width * c.left);
  const y = Math.round(img.height * c.top);
  const w = Math.round(img.width * (1 - c.left - c.right));
  const h = Math.round(img.height * (1 - c.top - c.bottom));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d")!.drawImage(img, x, y, w, h, 0, 0, w, h);
  return canvas.toDataURL("image/png");
}

/** Small grayscale thumbnail (64x64 luminance) used to tell whether the screen changed or is still moving, without OCR. */
export async function fingerprintDataUrl(dataUrl: string): Promise<Uint8Array> {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const N = 64;
  const canvas = document.createElement("canvas");
  canvas.width = N;
  canvas.height = N;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, N, N);
  const px = ctx.getImageData(0, 0, N, N).data;
  const out = new Uint8Array(N * N);
  for (let i = 0; i < out.length; i++) out[i] = Math.round(0.299 * px[i * 4]! + 0.587 * px[i * 4 + 1]! + 0.114 * px[i * 4 + 2]!);
  return out;
}

/** Number of distinct page-turn methods `turnPage` supports. The capture engine tries them in order when a turn does not take effect. */
export const TURN_METHODS = 3;

/**
 * Advance the reader one page, using method 0 (Right Arrow key), 1 (click on the right edge) or 2 (Page Down key).
 * Runs inside the page (all frames) because Kindle Cloud Reader renders in an iframe. Synthetic events can be
 * ignored by a site; the capture engine verifies every turn and falls back to the next method.
 */
export async function turnPage(tabId: number, method = 0): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    args: [method],
    func: (m: number) => {
      const key = (name: string, code: number) => {
        const init = { key: name, code: name, keyCode: code, which: code, bubbles: true, cancelable: true } as KeyboardEventInit;
        // One target only: the events bubble to document/window listeners, so several targets would turn several pages.
        const target = document.activeElement ?? document.body;
        target.dispatchEvent(new KeyboardEvent("keydown", init));
        target.dispatchEvent(new KeyboardEvent("keyup", init));
      };
      if (m === 0) return key("ArrowRight", 39);
      if (m === 2) return key("PageDown", 34);
      // Method 1: click the page's right-hand turn zone. Skip tiny frames (ads, trackers).
      if (innerWidth < 300 || innerHeight < 200) return;
      const x = Math.round(innerWidth * 0.93);
      const y = Math.round(innerHeight * 0.5);
      const el = document.elementFromPoint(x, y) ?? document.body;
      const base = { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window } as MouseEventInit;
      for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
        el.dispatchEvent(type.startsWith("pointer") ? new PointerEvent(type, base) : new MouseEvent(type, base));
      }
    },
  });
}
