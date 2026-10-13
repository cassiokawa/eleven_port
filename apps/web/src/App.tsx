import { useCallback, useEffect, useRef, useState } from "react";
import {
  collectionTree, deleteCollection, exportArchive, getParts, importArchive, itemToMarkdown, listItems,
  moveItem, parseMarkdown, renameCollection, savePosition, searchIndex,
  blocksToMarkdown, localSuggestions, type ServerConfig, narrate, refineSuggestions, type Suggestions, updatePart, type Player, type CollectionNode, type Item, type Part,
} from "@eleven-port/core";
import { db } from "./db";
import { getServerConfig } from "./api";
import { loadSettings, saveSettings, type Settings } from "./settings";
import { ingestMarkdown, ingestPdf, ingestUrl, resumePending, retryFailed } from "./ingest";



function download(name: string, data: BlobPart, type: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([data], { type }));
  a.download = name;
  a.click();
}

export function App() {
  const [items, setItems] = useState<Item[]>([]);
  const [query, setQuery] = useState("");
  const [tag, setTag] = useState("");
  const [folder, setFolder] = useState("");
  const [tree, setTree] = useState<CollectionNode[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    setTree(await collectionTree(db));
    let list = await listItems(db, { tag: tag || undefined, collection: folder || undefined });
    if (query.trim()) {
      const ids = new Set((await searchIndex(db)).search(query, { prefix: true }).map((h) => h.itemId as string));
      list = list.filter((i) => ids.has(i.id));
    }
    setItems(list);
  }, [query, tag, folder]);
  useEffect(() => void refresh(), [refresh]);
  useEffect(() => { void resumePending().then(refresh).catch(() => {}); }, [refresh]);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setError("");
    try { await fn(); } catch (e) { setError((e as Error).message); }
    setBusy("");
    await refresh();
  };

  const onFiles = (files: FileList | null) =>
    files && [...files].forEach((f) =>
      run(`Importing ${f.name}`, async () => {
        if (/\.pdf$/i.test(f.name)) await ingestPdf(f.name, new Uint8Array(await f.arrayBuffer()), (d, t) => setBusy(`${f.name}: ${d}/${t} pages`));
        else if (/\.zip$/i.test(f.name)) await importArchive(db, new Uint8Array(await f.arrayBuffer()));
        else await ingestMarkdown(f.name, await f.text());
      }),
    );

  const urlRef = useRef<HTMLInputElement>(null);

  if (open) return <Reader id={open} onBack={() => { setOpen(null); void refresh(); }} />;

  return (
    <main style={{ maxWidth: 820, margin: "2rem auto", padding: "0 1rem", fontFamily: "system-ui" }}>
      <h1>eleven_port</h1>
      <section onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); onFiles(e.dataTransfer.files); }}
        style={{ border: "2px dashed #999", padding: "1rem", borderRadius: 8 }}>
        <p>Drop PDF, Markdown or archive (.zip) files here, or <input type="file" multiple onChange={(e) => onFiles(e.target.files)} /></p>
        <form onSubmit={(e) => { e.preventDefault(); const u = urlRef.current!.value.trim(); if (u) void run("Fetching URL", () => ingestUrl(u)); }}>
          <input ref={urlRef} placeholder="https://example.com/article" style={{ width: "70%" }} /> <button>Import URL</button>
        </form>
      </section>
      {busy && <p>{busy}</p>}
      {error && <p role="alert" style={{ color: "crimson" }}>{error}</p>}
      <p>
        <input placeholder="Search library" value={query} onChange={(e) => setQuery(e.target.value)} />{" "}
        <input placeholder="Filter by tag" value={tag} onChange={(e) => setTag(e.target.value)} />{" "}
        <button onClick={() => void run("Exporting", async () => download("library.zip", await exportArchive(db) as BlobPart, "application/zip"))}>Export library</button>
      </p>
      <SettingsPanel />
      <Folders tree={tree} current={folder} onPick={setFolder} onChanged={refresh} />
      <ul style={{ listStyle: "none", padding: 0 }}>
        {items.map((i) => (
          <li key={i.id} style={{ padding: ".5rem 0", borderBottom: "1px solid #ddd" }}>
            <button onClick={() => setOpen(i.id)} style={{ all: "unset", cursor: "pointer", fontWeight: 600 }}>{i.title}</button>{" "}
            <small>{i.kind} · {i.status}{i.collection ? ` · ${i.collection}` : ""}{i.tags.length ? ` · ${i.tags.join(", ")}` : ""}</small>
          </li>
        ))}
        {!items.length && <li>No items yet.</li>}
      </ul>
    </main>
  );
}

function SettingsPanel() {
  const [s, setS] = useState<Settings>(loadSettings);
  const [server, setServer] = useState<ServerConfig | undefined>();
  useEffect(() => { void getServerConfig(true).then(setServer); }, [s.token]);
  const set = (patch: Partial<Settings>) => { const n = { ...s, ...patch }; setS(n); saveSettings(n); };
  const localTts = server?.tts === "local";
  return (
    <details>
      <summary>Voice, engines and API settings</summary>
      <p>
        {server
          ? <small>Server: suggestions via <b>{server.llm}</b>{server.llmConfigured ? "" : " (not configured)"} · narration via <b>{server.tts}</b>{server.ttsConfigured ? "" : " (not configured)"}</small>
          : <small>API server not reachable</small>}
      </p>
      <p>
        <label>Voice {localTts ? "name" : "ID"} <input value={s.voiceId} onChange={(e) => set({ voiceId: e.target.value })} /></label>{" "}
        <label>API token <input type="password" value={s.token} onChange={(e) => set({ token: e.target.value })} /></label>
      </p>
      {!localTts && (
        <p>
          <label>Stability {s.stability} <input type="range" min={0} max={1} step={0.05} value={s.stability} onChange={(e) => set({ stability: Number(e.target.value) })} /></label>{" "}
          <label>Similarity {s.similarity} <input type="range" min={0} max={1} step={0.05} value={s.similarity} onChange={(e) => set({ similarity: Number(e.target.value) })} /></label>
        </p>
      )}
      <p>
        <label>OCR engine for scanned pages{" "}
          <select value={s.ocrEngine} onChange={(e) => set({ ocrEngine: e.target.value as Settings["ocrEngine"] })}>
            <option value="tesseract">Tesseract (bundled, fast)</option>
            <option value="local-vision" disabled={!server?.ocr.includes("local-vision")}>Local vision model (slower, set OLLAMA_VISION_MODEL)</option>
          </select>
        </label>
      </p>
    </details>
  );
}

function Folders({ tree, current, onPick, onChanged }: { tree: CollectionNode[]; current: string; onPick: (p: string) => void; onChanged: () => void }) {
  const render = (nodes: CollectionNode[], depth = 0): React.ReactNode =>
    nodes.map((n) => (
      <div key={n.path} style={{ paddingLeft: depth * 16 }}>
        <button onClick={() => onPick(n.path)} style={{ fontWeight: current === n.path ? 700 : 400 }}>{n.name} ({n.count})</button>{" "}
        <button title="Rename" onClick={async () => { const v = prompt("New name", n.name); if (v) { if (current === n.path) onPick(""); await renameCollection(db, n.path, v); onChanged(); } }}>✎</button>{" "}
        <button title="Delete folder (items are kept)" onClick={async () => { if (confirm(`Delete folder ${n.path}? Items are kept.`)) { if (current.startsWith(n.path)) onPick(""); await deleteCollection(db, n.path); onChanged(); } }}>✕</button>
        {render(n.children, depth + 1)}
      </div>
    ));
  if (!tree.length) return null;
  return (
    <nav aria-label="Collections">
      <button onClick={() => onPick("")} style={{ fontWeight: current === "" ? 700 : 400 }}>All</button>
      {render(tree)}
    </nav>
  );
}

function Reader({ id, onBack }: { id: string; onBack: () => void }) {
  const [item, setItem] = useState<Item>();
  const [parts, setParts] = useState<Part[]>([]);
  const [pos, setPos] = useState<{ i: number; n: number } | null>(null);
  const [err, setErr] = useState("");
  const [prog, setProg] = useState("");
  const [sugg, setSugg] = useState<Suggestions>();
  const player = useRef<Player | undefined>(undefined);

  const load = useCallback(async () => {
    setItem(await db.items.get(id));
    setParts(await getParts(db, id));
  }, [id]);
  useEffect(() => { void load(); return () => player.current?.stop(); }, [load]);

  // part = -1 narrates the whole item; resume continues from the saved chunk.
  const play = async (text: string, part = -1, resume = false) => {
    player.current?.stop();
    const cfg = loadSettings();
    const server = await getServerConfig();
    setErr("");
    const start = resume && item?.position?.part === part ? item.position.chunk : 0;
    player.current = narrate(
      text,
      { db, apiBase: "/api", voiceId: cfg.voiceId, token: cfg.token || undefined, voiceSettings: server?.tts === "local" ? undefined : { stability: cfg.stability, similarity_boost: cfg.similarity }, engine: server?.tts },
      {
        onChunk: (i, n) => { setPos({ i, n }); void savePosition(db, id, part, i); },
        onDone: () => { setPos(null); void savePosition(db, id, part, 0); },
        onError: (e) => setErr(e.message),
      },
      start,
    );
  };

  const suggest = async () => {
    const all = await db.items.toArray();
    const ctx = {
      title: item?.title ?? "",
      blocks: parts.flatMap((p) => p.blocks),
      vocabulary: [...new Set(all.flatMap((i) => i.tags))],
      collections: [...new Set(all.map((i) => i.collection).filter((c): c is string => !!c))],
    };
    const local = localSuggestions(ctx);
    setSugg(local);
    // Claude refinement is optional: if the API has no key or is unreachable, the local result stays.
    refineSuggestions("/api", ctx, local, fetch, loadSettings().token || undefined).then(setSugg).catch(() => {});
  };

  const applyTag = async (t: string) => {
    if (!item) return;
    await db.items.update(id, { tags: [...new Set([...item.tags, t])] });
    await load();
  };

  const retryPart = async (p: Part) => {
    // Re-processing a failed part needs the original source; for now allow manual replacement.
    const text = prompt(`Paste text for ${p.title || `part ${p.index + 1}`}`);
    if (!text) return;
    await updatePart(db, id, p.index, parseMarkdown(text));
    await load();
  };

  if (!item) return <p>Loading…</p>;
  return (
    <main style={{ maxWidth: 820, margin: "2rem auto", padding: "0 1rem", fontFamily: "system-ui" }}>
      <button onClick={onBack}>← Library</button>
      <h1>{item.title}</h1>
      <p><small>{item.kind} · {item.status} · {item.source}</small></p>
      <p>
        <button onClick={async () => play(await itemToMarkdown(db, id))}>▶ Narrate all</button>{" "}
        {item.position && item.position.chunk > 0 && item.position.part === -1 && (
          <button onClick={async () => play(await itemToMarkdown(db, id), -1, true)}>⏵ Resume (chunk {item.position.chunk + 1})</button>
        )}{" "}
        <button onClick={() => { player.current?.stop(); setPos(null); }}>■ Stop</button>{" "}
        <button onClick={async () => download(`${item.title}.md`, await itemToMarkdown(db, id), "text/markdown")}>Export .md</button>{" "}
        <label>Folder: <input defaultValue={item.collection ?? ""} placeholder="Science/Physics" onBlur={async (e) => { await moveItem(db, id, e.target.value); await load(); }} /></label>{" "}
        <button onClick={() => void suggest()}>Suggest tags / index</button>{" "}
        {parts.some((p) => p.status !== "ok") && (
          <button
            onClick={async () => {
              setErr("");
              try {
                const r = await retryFailed(item, (d, t) => setProg(`Reprocessing part ${d}/${t}`));
                setErr(`Retried: ${r.fixed} fixed, ${r.failed} still failing`);
              } catch (e) { setErr((e as Error).message); }
              setProg("");
              await load();
            }}
          >Retry failed parts</button>
        )}{" "}
        <button onClick={async () => { if (confirm("Delete this item?")) { await db.parts.where("itemId").equals(id).delete(); await db.items.delete(id); onBack(); } }}>Delete</button>
      </p>
      {pos && <p>Narrating chunk {pos.i + 1}/{pos.n}</p>}
      {prog && <p>{prog}</p>}
      {err && <p role="alert" style={{ color: "crimson" }}>{err}</p>}
      {sugg && (
        <section style={{ background: "#f4f4f4", padding: ".75rem", borderRadius: 6 }}>
          <strong>Suggested tags</strong>{" "}
          {sugg.tags.map((t) => <button key={t.tag} onClick={() => void applyTag(t.tag)}>{t.existing ? "" : "+ "}{t.tag}</button>)}{sugg.refined && <small> refined by Claude{sugg.summary ? `: ${sugg.summary}` : ""}</small>}
          {sugg.collection && <p>Suggested collection: <button onClick={async () => { await db.items.update(id, { collection: sugg.collection }); await load(); }}>{sugg.collection}</button></p>}
          {sugg.toc && <details open><summary>Proposed index</summary><pre>{sugg.toc}</pre></details>}
        </section>
      )}
      {parts.map((p) => (
        <article key={p.id} style={{ borderTop: "1px solid #ddd", marginTop: "1rem" }}>
          <h3>{p.title || `Part ${p.index + 1}`} {p.status !== "ok" && <em style={{ color: "crimson" }}>({p.status})</em>}</h3>
          {p.status === "ok" ? <pre style={{ whiteSpace: "pre-wrap", fontFamily: "inherit" }}>{blocksToMarkdown(p.blocks)}</pre> : <button onClick={() => void retryPart(p)}>Replace manually</button>}
          {p.status === "ok" && <button onClick={() => play(blocksToMarkdown(p.blocks), p.index)}>▶ Narrate this part</button>}
          {" "}<button onClick={async () => {
            const v = prompt("Edit Markdown for this part", blocksToMarkdown(p.blocks));
            if (v !== null) { await updatePart(db, id, p.index, parseMarkdown(v)); await load(); }
          }}>Edit</button>
        </article>
      ))}
    </main>
  );
}
