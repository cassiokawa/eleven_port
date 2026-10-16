import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { LibraryDB, addItem, getParts, ocrToBlocks, refreshStatus, reprocessFailedParts, savePart } from "../src";

let db: LibraryDB;
beforeEach(async () => {
  db = new LibraryDB(`r-${Math.random()}`);
  await db.open();
});

describe("reprocess", () => {
  it("fixes failed parts independently and updates item status", async () => {
    const it = await addItem(db, { kind: "pdf", title: "T", source: "f" });
    await savePart(db, it.id, 0, "p1", [{ type: "paragraph", text: "ok" }]);
    await savePart(db, it.id, 1, "p2", [], "failed");
    await savePart(db, it.id, 2, "p3", [], "failed");
    await refreshStatus(db, it.id, 3);
    const r = await reprocessFailedParts(db, it.id, async (p) => {
      if (p.index === 2) throw new Error("still bad");
      return [{ type: "paragraph", text: "recovered" }];
    });
    expect(r).toEqual({ fixed: 1, failed: 1 });
    expect((await getParts(db, it.id)).map((p) => p.status)).toEqual(["ok", "ok", "failed"]);
    expect((await db.items.get(it.id))!.status).toBe("partial");
    const r2 = await reprocessFailedParts(db, it.id, async () => [{ type: "paragraph", text: "x" }]);
    expect(r2.fixed).toBe(1);
    expect((await db.items.get(it.id))!.status).toBe("complete");
  });

  it("converts OCR text to blocks", async () => {
    const blocks = await ocrToBlocks({ recognize: async () => "# Title\n\nline one\nline two", terminate: async () => {} }, "x");
    expect(blocks.map((b) => b.type)).toEqual(["heading", "paragraph"]);
    expect(blocks[1]!.text).toBe("line one line two");
  });
});
