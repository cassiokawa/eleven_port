import { zipSync, unzipSync, strToU8, strFromU8 } from "fflate";
import MiniSearch from "minisearch";
import { assemblePages } from "./assemble";
import { hashText } from "./hash";
import { blocksToMarkdown, parseMarkdown } from "./markdown";
import type { LibraryDB } from "./store";
import type { Block, Item, ItemKind, Part } from "./types";

export interface NewItem {
  kind: ItemKind;
  title: string;
  source: string;
  author?: string;
  tags?: string[];
  collection?: string;
}

export async function addItem(db: LibraryDB, n: NewItem, now = Date.now()): Promise<Item> {
  const item: Item = {
    id: `${hashText(n.source + n.title)}-${now.toString(36)}`,
    kind: n.kind,
    title: n.title,
    author: n.author,
    source: n.source,
    capturedAt: now,
    status: "partial",
    tags: n.tags ?? [],
    collection: n.collection,
  };
  await db.items.put(item);
  return item;
}

/** Save (or replace) one part. Idempotent per (item, index); a part can be saved as soon as it is ready. */
export async function savePart(
  db: LibraryDB,
  itemId: string,
  index: number,
  title: string,
  blocks: Block[],
  status: Part["status"] = "ok",
): Promise<Part> {
  const part: Part = { id: `${itemId}:${index}`, itemId, index, title, blocks, status, hash: hashText(JSON.stringify(blocks)) };
  await db.parts.put(part);
  return part;
}

export async function getParts(db: LibraryDB, itemId: string): Promise<Part[]> {
  return db.parts.where("itemId").equals(itemId).sortBy("index");
}

/** Recompute completeness: complete only when `expected` parts exist and all are ok. */
export async function refreshStatus(db: LibraryDB, itemId: string, expected?: number): Promise<Item["status"]> {
  const parts = await getParts(db, itemId);
  const complete = parts.length > 0 && parts.every((p) => p.status === "ok") && (expected === undefined || parts.length === expected);
  const status = complete ? "complete" : "partial";
  await db.items.update(itemId, { status });
  return status;
}

const GAP = (p: Part) => `> [!missing] Part ${p.index + 1}${p.title ? ` (${p.title})` : ""} failed to capture.`;

/** Merge parts into one Markdown document; failed/pending parts leave a visible gap marker. */
export async function itemToMarkdown(db: LibraryDB, itemId: string): Promise<string> {
  const item = await db.items.get(itemId);
  const parts = await getParts(db, itemId);
  const body = parts.map((p) => (p.status === "ok" ? blocksToMarkdown(p.blocks).trimEnd() : GAP(p))).join("\n\n");
  return `${item ? `# ${item.title}\n\n` : ""}${body}\n`;
}

/** Merge raw per-page text (e.g. OCR output) into parts' blocks via the assembler. */
export const pagesToBlocks = assemblePages;

export async function searchIndex(db: LibraryDB): Promise<MiniSearch> {
  const ms = new MiniSearch({ fields: ["title", "text", "tags"], storeFields: ["itemId"], idField: "id" });
  const items = await db.items.toArray();
  const docs = [];
  for (const it of items) {
    const parts = await getParts(db, it.id);
    docs.push({
      id: it.id,
      itemId: it.id,
      title: it.title,
      tags: it.tags.join(" "),
      text: parts.map((p) => blocksToMarkdown(p.blocks)).join("\n"),
    });
  }
  ms.addAll(docs);
  return ms;
}

export interface Filter {
  tag?: string;
  collection?: string;
  status?: Item["status"];
  kind?: ItemKind;
}

export async function listItems(db: LibraryDB, f: Filter = {}): Promise<Item[]> {
  return (await db.items.orderBy("capturedAt").reverse().toArray()).filter(
    (i) =>
      (!f.tag || i.tags.includes(f.tag)) &&
      (!f.collection || i.collection === f.collection || i.collection?.startsWith(f.collection + "/")) &&
      (!f.status || i.status === f.status) &&
      (!f.kind || i.kind === f.kind),
  );
}

interface Manifest {
  version: 1;
  items: Item[];
  parts: Omit<Part, "blocks">[];
}

/** Export the whole library as a zip: manifest.json + one .md per part + one merged .md per item. */
export async function exportArchive(db: LibraryDB): Promise<Uint8Array> {
  const items = await db.items.toArray();
  const parts = await db.parts.toArray();
  const files: Record<string, Uint8Array> = {};
  for (const p of parts) files[`parts/${p.id.replace(/[^\w.-]/g, "_")}.md`] = strToU8(blocksToMarkdown(p.blocks));
  for (const it of items) files[`items/${it.id}.md`] = strToU8(await itemToMarkdown(db, it.id));
  const manifest: Manifest = { version: 1, items, parts: parts.map((p) => ({ id: p.id, itemId: p.itemId, index: p.index, title: p.title, hash: p.hash, status: p.status })) };
  files["manifest.json"] = strToU8(JSON.stringify(manifest));
  return zipSync(files);
}

/** Import an archive; existing items/parts with the same id are replaced. Returns counts. */
export async function importArchive(db: LibraryDB, zip: Uint8Array): Promise<{ items: number; parts: number }> {
  const files = unzipSync(zip);
  const raw = files["manifest.json"];
  if (!raw) throw new Error("not an eleven-port archive: manifest.json missing");
  const m = JSON.parse(strFromU8(raw)) as Manifest;
  if (m.version !== 1) throw new Error(`unsupported archive version ${m.version}`);
  const parts: Part[] = m.parts.map((p) => {
    const md = files[`parts/${p.id.replace(/[^\w.-]/g, "_")}.md`];
    return { ...p, blocks: md ? parseMarkdown(strFromU8(md)) : [] };
  });
  await db.transaction("rw", db.items, db.parts, async () => {
    await db.items.bulkPut(m.items);
    await db.parts.bulkPut(parts);
  });
  return { items: m.items.length, parts: parts.length };
}
