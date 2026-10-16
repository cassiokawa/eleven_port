import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { LibraryDB, addItem, exportArchive, getParts, importArchive, itemToMarkdown, listItems, refreshStatus, savePart, searchIndex } from "../src";

let db: LibraryDB;
beforeEach(async () => {
  db = new LibraryDB(`l-${Math.random()}`);
  await db.open();
});

const para = (text: string) => [{ type: "paragraph" as const, text }];

describe("library", () => {
  it("saves parts incrementally; partial until all parts are ok", async () => {
    const it = await addItem(db, { kind: "book", title: "Book", source: "kindle:abc" });
    await savePart(db, it.id, 0, "Ch1", para("one"));
    expect(await refreshStatus(db, it.id, 2)).toBe("partial");
    await savePart(db, it.id, 1, "Ch2", para("two"), "failed");
    expect(await refreshStatus(db, it.id, 2)).toBe("partial");
    expect(await itemToMarkdown(db, it.id)).toContain("failed to capture");
    await savePart(db, it.id, 1, "Ch2", para("two"));
    expect(await refreshStatus(db, it.id, 2)).toBe("complete");
    expect((await getParts(db, it.id)).map((p) => p.index)).toEqual([0, 1]);
  });

  it("searches and filters", async () => {
    const a = await addItem(db, { kind: "article", title: "Quantum", source: "u1", tags: ["physics"], collection: "Science/Physics" });
    const b = await addItem(db, { kind: "article", title: "Pasta", source: "u2", tags: ["food"] });
    await savePart(db, a.id, 0, "", para("entanglement of particles"));
    await savePart(db, b.id, 0, "", para("boil water"));
    const hits = (await searchIndex(db)).search("entanglement");
    expect(hits.map((h) => h.itemId)).toEqual([a.id]);
    expect((await listItems(db, { collection: "Science" })).map((i) => i.id)).toEqual([a.id]);
    expect((await listItems(db, { tag: "food" })).map((i) => i.id)).toEqual([b.id]);
  });

  it("round-trips an archive into an empty library", async () => {
    const it = await addItem(db, { kind: "book", title: "B", source: "s", tags: ["x"] });
    await savePart(db, it.id, 0, "Ch1", [{ type: "heading", level: 1, text: "Ch1" }, ...para("hello world")]);
    await refreshStatus(db, it.id, 1);
    const zip = await exportArchive(db);

    const db2 = new LibraryDB(`l2-${Math.random()}`);
    await db2.open();
    expect(await importArchive(db2, zip)).toEqual({ items: 1, parts: 1 });
    expect(await db2.items.toArray()).toEqual(await db.items.toArray());
    expect((await getParts(db2, it.id))[0]!.blocks).toEqual((await getParts(db, it.id))[0]!.blocks);
  });

  it("rejects non-archives", async () => {
    await expect(importArchive(db, new Uint8Array([80, 75, 5, 6, ...new Array(18).fill(0)]))).rejects.toThrow("manifest");
  });
});
