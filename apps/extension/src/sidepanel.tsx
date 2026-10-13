import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  LibraryDB, addItem, captureBook, cleanOcrText, exportArchive, itemToMarkdown, listItems, narrate, parseMarkdown,
  refreshStatus, savePart, savePosition, type Item, type Player,
} from "@eleven-port/core";
import { getOcr } from "./ocr";
import { activeTab, cropDataUrl, extractFromTab, screenshot, turnPage } from "./tab";

const db = new LibraryDB();
const DEFAULT_API = "http://localhost:8787";
const DEFAULT_VOICE = "21m00Tcm4TlvDq8ikWAM";

const store = {
  get: async <T,>(k: string, d: T): Promise<T> => ((await chrome.storage.local.get(k))[k] as T) ?? d,
  set: (k: string, v: unknown) => chrome.storage.local.set({ [k]: v }),
};

function download(name: string, data: BlobPart, type: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([data], { type }));
  a.download = name;
  a.click();
}

function Panel() {
  const [items, setItems] = useState<Item[]>([]);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [api, setApi] = useState(DEFAULT_API);
  const [voice, setVoice] = useState(DEFAULT_VOICE);
  const [bookId, setBookId] = useState<string>();
  const [capturing, setCapturing] = useState(false);
  const abort = useRef<AbortController | undefined>(undefined);
  const player = useRef<Player | undefined>(undefined);

  const refresh = useCallback(async () => setItems(await listItems(db)), []);
  useEffect(() => {
    void refresh();
    void store.get("api", DEFAULT_API).then(setApi);
    void store.get("voice", DEFAULT_VOICE).then(setVoice);
    void store.get<string | undefined>("bookId", undefined).then(setBookId);
  }, [refresh]);

  const guard = async (label: string, fn: () => Promise<void>) => {
    setError("");
    setStatus(label);
    try { await fn(); } catch (e) { setError((e as Error).message); }
    setStatus("");
    await refresh();
  };

  const capturePage = () => guard("Capturing page…", async () => {
    const tab = await activeTab();
    const r = await extractFromTab(tab.id!);
    if (!r.ok || !r.blocks) throw new Error(r.error ?? "capture failed");
    const item = await addItem(db, { kind: "article", title: r.title ?? tab.title ?? "Untitled", author: r.author, source: r.url ?? tab.url ?? "" });
    await savePart(db, item.id, 0, "", r.blocks);
    await refreshStatus(db, item.id, 1);
  });

  const captureScreen = () => guard("Reading screen (OCR)…", async () => {
    const tab = await activeTab();
    const ocr = await getOcr();
    const text = cleanOcrText(await ocr.recognize(await screenshot(tab.windowId)));
    if (!text) throw new Error("no text recognized on screen");
    const item = await addItem(db, { kind: "note", title: `Screen: ${tab.title ?? "capture"}`, source: tab.url ?? "screen" });
    await savePart(db, item.id, 0, "", parseMarkdown(text));
    await refreshStatus(db, item.id, 1);
  });

  const captureBookRun = async (resumeId?: string) => {
    setError("");
    setCapturing(true);
    abort.current = new AbortController();
    try {
      const tab = await activeTab();
      const id = resumeId ?? (await addItem(db, { kind: "book", title: tab.title?.replace(/^Amazon\.com:\s*/, "") ?? "Kindle book", source: tab.url ?? "kindle" })).id;
      setBookId(id);
      await store.set("bookId", id);
      const ocr = await getOcr();
      const crop = { top: 0.08, bottom: 0.08, left: 0.1, right: 0.1 };
      const res = await captureBook(
        db,
        id,
        {
          capture: async () => cropDataUrl(await screenshot(tab.windowId), crop),
          ocr: async (img) => ocr.recognize(img),
          turn: () => turnPage(tab.id!),
          sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
          signal: abort.current.signal,
        },
        { settleMs: 1000, onProgress: (n) => setStatus(`Captured ${n} pages`) },
      );
      if (res.state === "needs-reposition") setError("The reader is not on the last saved page. Navigate to it, then press Resume.");
      else if (res.state === "paused") setStatus(`Paused after ${res.pages} pages. Progress is saved.`);
      else setStatus(`Done: ${res.pages} pages${res.gaps.length ? `, unreadable: ${res.gaps.join(", ")}` : ""}`);
    } catch (e) {
      setError((e as Error).message);
    }
    setCapturing(false);
    await refresh();
  };

  const play = async (item: Item) => {
    player.current?.stop();
    const md = await itemToMarkdown(db, item.id);
    const start = item.position?.part === -1 ? item.position.chunk : 0;
    player.current = narrate(
      md,
      { db, apiBase: api, voiceId: voice },
      {
        onChunk: (i, n) => { setStatus(`Narrating ${i + 1}/${n}`); void savePosition(db, item.id, -1, i); },
        onDone: () => { setStatus(""); void savePosition(db, item.id, -1, 0); },
        onError: (e) => setError(e.message),
      },
      start,
    );
  };

  return (
    <div>
      <h3>eleven_port</h3>
      <div>
        <button disabled={capturing} onClick={capturePage}>Capture page</button>
        <button disabled={capturing} onClick={captureScreen}>Read screen (OCR)</button>
      </div>
      <div>
        {!capturing && <button onClick={() => void captureBookRun()}>Capture book (Kindle)</button>}
        {!capturing && bookId && <button onClick={() => void captureBookRun(bookId)}>Resume book</button>}
        {capturing && <button onClick={() => abort.current?.abort()}>Pause / stop</button>}
      </div>
      {status && <p>{status}</p>}
      {error && <p role="alert" style={{ color: "crimson" }}>{error}</p>}
      <ul style={{ paddingLeft: 16 }}>
        {items.map((i) => (
          <li key={i.id}>
            <strong>{i.title}</strong> <small>({i.kind}, {i.status})</small>
            <div>
              <button onClick={() => void play(i)}>▶</button>
              <button onClick={() => { player.current?.stop(); setStatus(""); }}>■</button>
              <button onClick={async () => download(`${i.title}.md`, await itemToMarkdown(db, i.id), "text/markdown")}>.md</button>
              <button onClick={async () => { await db.parts.where("itemId").equals(i.id).delete(); await db.items.delete(i.id); await refresh(); }}>✕</button>
            </div>
          </li>
        ))}
      </ul>
      <button onClick={async () => download("library.zip", (await exportArchive(db)) as BlobPart, "application/zip")}>Export library (.zip)</button>
      <details>
        <summary>Settings</summary>
        <label>API <input value={api} onChange={(e) => { setApi(e.target.value); void store.set("api", e.target.value); }} /></label>
        <label>Voice ID <input value={voice} onChange={(e) => { setVoice(e.target.value); void store.set("voice", e.target.value); }} /></label>
      </details>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Panel />);
