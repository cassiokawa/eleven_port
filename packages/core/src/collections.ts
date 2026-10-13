import type { LibraryDB } from "./store";
import type { Item } from "./types";

export interface CollectionNode {
  name: string;
  path: string;
  count: number;
  children: CollectionNode[];
}

const norm = (p: string) => p.split("/").map((s) => s.trim()).filter(Boolean).join("/");

/** Create a folder and all its ancestors. */
export async function addCollection(db: LibraryDB, path: string): Promise<string> {
  const p = norm(path);
  if (!p) throw new Error("empty collection path");
  const segs = p.split("/");
  await db.collections.bulkPut(segs.map((_, i) => ({ path: segs.slice(0, i + 1).join("/") })));
  return p;
}

export async function moveItem(db: LibraryDB, itemId: string, path: string | undefined): Promise<void> {
  if (path === undefined || norm(path) === "") {
    await db.items.update(itemId, { collection: undefined });
    return;
  }
  await db.items.update(itemId, { collection: await addCollection(db, path) });
}

/** Folder tree built from the collection table plus any paths items reference. Counts include descendants. */
export async function collectionTree(db: LibraryDB): Promise<CollectionNode[]> {
  const [cols, items] = await Promise.all([db.collections.toArray(), db.items.toArray()]);
  const paths = new Set(cols.map((c) => c.path));
  for (const it of items) {
    if (!it.collection) continue;
    const segs = it.collection.split("/");
    segs.forEach((_, i) => paths.add(segs.slice(0, i + 1).join("/")));
  }
  const nodes = new Map<string, CollectionNode>();
  for (const path of [...paths].sort()) {
    const name = path.split("/").pop()!;
    nodes.set(path, { name, path, count: 0, children: [] });
  }
  const roots: CollectionNode[] = [];
  for (const [path, node] of nodes) {
    const parent = nodes.get(path.split("/").slice(0, -1).join("/"));
    (parent ? parent.children : roots).push(node);
  }
  for (const it of items) {
    if (!it.collection) continue;
    const segs = it.collection.split("/");
    segs.forEach((_, i) => {
      const n = nodes.get(segs.slice(0, i + 1).join("/"));
      if (n) n.count++;
    });
  }
  return roots;
}

/** Rename a folder (last segment), rewriting descendants and items. */
export async function renameCollection(db: LibraryDB, path: string, newName: string): Promise<string> {
  const leaf = norm(newName);
  if (!leaf || leaf.includes("/")) throw new Error("invalid collection name");
  const parent = path.split("/").slice(0, -1);
  const to = [...parent, leaf].join("/");
  await rewritePrefix(db, path, to);
  return to;
}

/** Delete a folder; its items become uncategorized (never deleted). */
export async function deleteCollection(db: LibraryDB, path: string): Promise<void> {
  const under = (p: string) => p === path || p.startsWith(path + "/");
  await db.transaction("rw", db.collections, db.items, async () => {
    await db.collections.filter((c) => under(c.path)).delete();
    await db.items.filter((i) => !!i.collection && under(i.collection)).modify({ collection: undefined });
  });
}

async function rewritePrefix(db: LibraryDB, from: string, to: string) {
  const re = (p: string) => (p === from ? to : to + p.slice(from.length));
  const under = (p: string) => p === from || p.startsWith(from + "/");
  await db.transaction("rw", db.collections, db.items, async () => {
    const cols = await db.collections.filter((c) => under(c.path)).toArray();
    await db.collections.bulkDelete(cols.map((c) => c.path));
    await db.collections.bulkPut(cols.map((c) => ({ path: re(c.path) })));
    const items: Item[] = await db.items.filter((i) => !!i.collection && under(i.collection)).toArray();
    await db.items.bulkPut(items.map((i) => ({ ...i, collection: re(i.collection!) })));
  });
}
