import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  LibraryDB, addItem, assembleCaptured, captureBook, cleanOcrText, exportArchive, fetchServerConfig, type ServerConfig, itemToMarkdown, listItems, narrate, parseMarkdown,
  refreshStatus, savePart, savePosition, type Item, type Player,
} from "@eleven-port/core";
import { getOcr, type OcrEngine } from "./ocr";
import { TURN_METHODS, activeTab, cropDataUrl, extractFromTab, fingerprintDataUrl, isAccessError, requestAllSitesAccess, screenshot, turnPage } from "./tab";

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
  const [token, setToken] = useState("");
  const [ocrEngine, setOcrEngine] = useState<OcrEngine>("tesseract");
  const [server, setServer] = useState<ServerConfig | undefined>();
  const [bookId, setBookId] = useState<string>();
  const [capturing, setCapturing] = useState(false);
  const [stalled, setStalled] = useState<string | undefined>();
  const [needAccess, setNeedAccess] = useState(false);
  const [partCounts, setPartCounts] = useState<Record<string, number>>({});
  const abort = useRef<AbortController | undefined>(undefined);
  const player = useRef<Player | undefined>(undefined);

  const refresh = useCallback(async () => {
    const list = await listItems(db);
    setItems(list);
    setPartCounts(Object.fromEntries(await Promise.all(list.map(async (i) => [i.id, await db.parts.where("itemId").equals(i.id).count()]))));
  }, []);
  useEffect(() => {
    void refresh();
    void store.get("api", DEFAULT_API).then(setApi);
    void store.get("voice", DEFAULT_VOICE).then(setVoice);
    void store.get("token", "").then(setToken);
    void store.get<OcrEngine>("ocrEngine", "tesseract").then(setOcrEngine);
    void store.get<string | undefined>("bookId", undefined).then(setBookId);
  }, [refresh]);

  useEffect(() => {
    const t = setTimeout(() => void fetchServerConfig(api, token || undefined).then(setServer), 400);
    return () => clearTimeout(t);
  }, [api, token]);

  const guard = async (label: string, fn: () => Promise<void>) => {
    setError("");
    setStatus(label);
    setNeedAccess(false);
    try { await fn(); } catch (e) { if (isAccessError(e)) setNeedAccess(true); else setError((e as Error).message); }
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
    const ocr = await getOcr(ocrEngine, api, token || undefined);
    const text = cleanOcrText(await ocr.recognize(await screenshot(tab.windowId)));
    if (!text) throw new Error("no text recognized on screen");
    const item = await addItem(db, { kind: "note", title: `Screen: ${tab.title ?? "capture"}`, source: tab.url ?? "screen" });
    await savePart(db, item.id, 0, "", parseMarkdown(text));
    await refreshStatus(db, item.id, 1);
  });

  const captureBookRun = async (resumeId?: string) => {
    setError("");
    setNeedAccess(false);
    setCapturing(true);
    setStalled(undefined);
    abort.current = new AbortController();
    let created: string | undefined;
    try {
      const tab = await activeTab();
      // Probe first: without access to this tab nothing can be captured, and no empty item should be left behind.
      await screenshot(tab.windowId);
      const id = resumeId ?? (created = (await addItem(db, { kind: "book", title: tab.title?.replace(/^Amazon\.com:\s*/, "") ?? "Kindle book", source: tab.url ?? "kindle" })).id);
      setBookId(id);
      await store.set("bookId", id);
      const ocr = await getOcr(ocrEngine, api, token || undefined);
      const crop = { top: 0.08, bottom: 0.08, left: 0.1, right: 0.1 };
      const res = await captureBook(
        db,
        id,
        {
          capture: async () => cropDataUrl(await screenshot(tab.windowId), crop),
          ocr: async (img) => ocr.recognize(img),
          turn: (method) => turnPage(tab.id!, method),
          fingerprint: fingerprintDataUrl,
          sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
          signal: abort.current.signal,
        },
        { settleMs: 1000, turnMethods: TURN_METHODS, onProgress: (n) => setStatus(`Captured ${n} pages`) },
      );
      const retries = res.retried ? `, ${res.retried} page${res.retried === 1 ? "" : "s"} needed a retried page turn` : "";
      if (res.state === "needs-reposition") setError("The reader is not on the last saved page. Navigate to it, then press Resume.");
      else if (res.state === "paused") setStatus(`Paused after ${res.pages} pages. Progress is saved.`);
      else if (res.state === "stalled") {
        setStalled(id);
        setError(`Stopped after ${res.pages} pages: the page did not change after trying every page-turn method. This is either the end of the book or the reader ignored the turn. Progress is saved as a partial book.`);
      } else setStatus(`Done: ${res.pages} pages${retries}${res.gaps.length ? `, unreadable: ${res.gaps.join(", ")}` : ""}`);
    } catch (e) {
      if (isAccessError(e)) setNeedAccess(true);
      else setError((e as Error).message);
      // A capture that failed before saving a single page must not leave an empty book in the library.
      if (created && (await db.units.where("jobId").equals(`${created}:open`).count()) === 0) {
        await db.jobs.delete(`${created}:open`);
        await db.items.delete(created);
      }
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
      { db, apiBase: api, voiceId: voice, token: token || undefined, engine: server?.tts },
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
      {needAccess && (
        <div style={{ border: "1px solid #c90", padding: 8, borderRadius: 6 }}>
          <p>Chrome has not allowed eleven_port to see this tab yet. Approve it once and capture will work on every site.</p>
          <button
            onClick={async () => {
              const ok = await requestAllSitesAccess();
              setNeedAccess(!ok);
              if (ok) setStatus("Access granted. Press the capture button again.");
              else setError("Access was not granted.");
            }}
          >
            Allow access to all sites
          </button>
          <p><small>Alternative: click the eleven_port toolbar icon while this tab is in front. That allows this tab only, until it navigates.</small></p>
        </div>
      )}
      {stalled && (
        <p>
          <button onClick={async () => { await assembleCaptured(db, stalled, `${stalled}:open`, true); setStalled(undefined); setError(""); setStatus("Marked complete."); await refresh(); }}>
            This was the end of the book: mark complete
          </button>
        </p>
      )}
      {status && <p>{status}</p>}
      {error && <p role="alert" style={{ color: "crimson" }}>{error}</p>}
      <ul style={{ paddingLeft: 16 }}>
        {items.map((i) => (
          <li key={i.id}>
            <strong>{i.title}</strong> <small>({i.kind}, {i.status})</small>
            <div>
              <button disabled={!partCounts[i.id]} title={partCounts[i.id] ? "Narrate" : "Nothing captured yet"} onClick={() => void play(i)}>▶</button>
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
        <label>API token <input type="password" value={token} onChange={(e) => { setToken(e.target.value); void store.set("token", e.target.value); }} /></label>
        <p><small>{server ? `Server: suggestions ${server.llm}, narration ${server.tts}` : "API server not reachable"}</small></p>
        <label>OCR engine{" "}
          <select value={ocrEngine} onChange={(e) => { setOcrEngine(e.target.value as OcrEngine); void store.set("ocrEngine", e.target.value); }}>
            <option value="tesseract">Tesseract (bundled, fast)</option>
            <option value="local-vision" disabled={!server?.ocr.includes("local-vision")}>Local vision model (slow)</option>
          </select>
        </label>
        <label>Voice ID <input value={voice} onChange={(e) => { setVoice(e.target.value); void store.set("voice", e.target.value); }} /></label>
      </details>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Panel />);
