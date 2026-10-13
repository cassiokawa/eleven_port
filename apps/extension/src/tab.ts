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

export async function screenshot(windowId: number): Promise<string> {
  // captureVisibleTab only sees the active tab; in the E2E hook the panel is itself a tab, so bring the target forward.
  if (forcedTab) await chrome.tabs.update(forcedTab, { active: true });
  return chrome.tabs.captureVisibleTab(windowId, { format: "png" });
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

/**
 * Advance the reader one page. Runs inside the page (all frames) because Kindle Cloud Reader
 * renders in an iframe. Tries the keyboard first, which the reader binds to turn pages.
 * Untrusted synthetic events can be ignored by a site; the capture loop detects a page that did not advance.
 */
export async function turnPage(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () => {
      const init = { key: "ArrowRight", code: "ArrowRight", keyCode: 39, which: 39, bubbles: true, cancelable: true } as KeyboardEventInit;
      // One target only: the events bubble to document/window listeners, so dispatching on several targets would turn several pages.
      const target = document.activeElement ?? document.body;
      target.dispatchEvent(new KeyboardEvent("keydown", init));
      target.dispatchEvent(new KeyboardEvent("keyup", init));
    },
  });
}
