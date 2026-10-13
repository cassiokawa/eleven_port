import { extractWeb } from "@eleven-port/core";

declare global {
  interface Window {
    __elevenPortInstalled?: boolean;
  }
}

// Injected on demand (activeTab); the guard keeps repeated injections from stacking listeners.
if (!window.__elevenPortInstalled) {
  window.__elevenPortInstalled = true;
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg?.type !== "extract") return;
    try {
      const r = extractWeb(document);
      reply(r ? { ok: true, title: r.title, author: r.author, url: location.href, blocks: r.blocks } : { ok: false, error: "no readable article found" });
    } catch (e) {
      reply({ ok: false, error: (e as Error).message });
    }
  });
}
