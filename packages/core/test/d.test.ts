import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  LibraryDB, addCollection, addItem, audioKey, collectionTree, createJob, deleteCollection, getAudio, getParts,
  moveItem, putAudio, renameCollection, resumeInterrupted, runJob, savePart, savePosition, updatePart,
} from "../src";

let db: LibraryDB;
beforeEach(async () => {
  db = new LibraryDB(`d-${Math.random()}`);
  await db.open();
});

describe("collections", () => {
  it("builds a tree with descendant counts, renames and deletes without losing items", async () => {
    const a = await addItem(db, { kind: "article", title: "A", source: "a" });
    const b = await addItem(db, { kind: "article", title: "B", source: "b" });
    await moveItem(db, a.id, "Science/Physics/Quantum");
    await moveItem(db, b.id, "Science/Chemistry");
    await addCollection(db, "Empty");
    let tree = await collectionTree(db);
    expect(tree.map((n) => [n.path, n.count])).toEqual([["Empty", 0], ["Science", 2]]);
    expect(tree[1]!.children.map((n) => n.name)).toEqual(["Chemistry", "Physics"]);

    await renameCollection(db, "Science/Physics", "Phys");
    expect((await db.items.get(a.id))!.collection).toBe("Science/Phys/Quantum");

    await deleteCollection(db, "Science");
    expect((await db.items.get(a.id))!.collection).toBeUndefined();
    expect(await db.items.count()).toBe(2);
    tree = await collectionTree(db);
    expect(tree.map((n) => n.path)).toEqual(["Empty"]);
  });
});

describe("audio cache", () => {
  it("evicts oldest beyond the cap", async () => {
    for (let i = 0; i < 5; i++) await putAudio(db, audioKey("v", `h${i}`), new Blob([`${i}`]), 3, i);
    expect(await getAudio(db, "v:h0")).toBeUndefined();
    expect(await getAudio(db, "v:h1")).toBeUndefined();
    expect(await getAudio(db, "v:h4")).toBeDefined();
    expect(await db.audio.count()).toBe(3);
  });
});

describe("edit + position + resume", () => {
  it("manual edit clears a failed gap and completes the item", async () => {
    const it = await addItem(db, { kind: "pdf", title: "T", source: "s" });
    await savePart(db, it.id, 0, "p", [], "failed");
    await updatePart(db, it.id, 0, [{ type: "paragraph", text: "fixed" }]);
    expect((await getParts(db, it.id))[0]!.status).toBe("ok");
    expect((await db.items.get(it.id))!.status).toBe("complete");
    await savePosition(db, it.id, 0, 4);
    expect((await db.items.get(it.id))!.position).toEqual({ part: 0, chunk: 4 });
  });

  it("resumes interrupted jobs on startup, skipping those without a worker", async () => {
    const i1 = await addItem(db, { kind: "pdf", title: "1", source: "1" });
    const i2 = await addItem(db, { kind: "pdf", title: "2", source: "2" });
    const j1 = await createJob(db, i1.id, 3);
    await createJob(db, i2.id, 2);
    const ac = new AbortController();
    await runJob(db, j1.id, async (u) => { if (u.index === 0) ac.abort(); return "x"; }, { signal: ac.signal });
    const seen: number[] = [];
    const r = await resumeInterrupted(db, async (item) =>
      item.id === i1.id ? async (u) => { seen.push(u.index); return "y"; } : undefined,
    );
    expect(r.resumed).toEqual([j1.id]);
    expect(r.skipped).toHaveLength(1);
    expect(seen).toEqual([1, 2]);
  });
});
