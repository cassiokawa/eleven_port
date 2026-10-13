import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { LibraryDB, addItem, captureBook, getParts, sameText, type PageCaptureDeps } from "../src";

let db: LibraryDB;
beforeEach(async () => {
  db = new LibraryDB(`k-${Math.random()}`);
  await db.open();
});

const PAGES = [
  "# Chapter One\n\nIt was a dark and stormy night and the rain fell in tor-",
  "rents across the old harbour town.\n\nThe lamps flickered along the quay.",
  "# Chapter Two\n\nMorning came grey and slow over the water.",
];

function reader(startAt = 0, overrides: Partial<PageCaptureDeps<number>> = {}) {
  let page = startAt;
  const turns: number[] = [];
  const deps: PageCaptureDeps<number> = {
    capture: async () => page,
    ocr: async (i) => PAGES[i]!,
    turn: async () => { turns.push(page); page = Math.min(page + 1, PAGES.length - 1); },
    sleep: async () => {},
    ...overrides,
  };
  return { deps, turns, get page() { return page; } };
}

describe("captureBook", () => {
  it("captures to the end, stops on repeated page, rejoins hyphenated text, splits chapters", async () => {
    const item = await addItem(db, { kind: "book", title: "Storm", source: "kindle:x" });
    const r = reader();
    const res = await captureBook(db, item.id, r.deps, { random: () => 0 });
    expect(res).toMatchObject({ state: "done", pages: 3, gaps: [] });
    const parts = await getParts(db, item.id);
    expect(parts.map((p) => p.title)).toEqual(["Chapter One", "Chapter Two"]);
    expect(parts[0]!.blocks[1]!.text).toContain("torrents across the old harbour town.");
    expect((await db.items.get(item.id))!.status).toBe("complete");
  });

  it("pauses on abort with partial pages readable, then resumes without re-capturing saved pages", async () => {
    const item = await addItem(db, { kind: "book", title: "Storm", source: "kindle:x" });
    const ac = new AbortController();
    const r = reader(0, { sleep: async () => { ac.abort(); } });
    const first = await captureBook(db, item.id, { ...r.deps, signal: ac.signal });
    expect(first).toMatchObject({ state: "paused", pages: 1 });
    expect((await getParts(db, item.id)).length).toBeGreaterThan(0);
    expect((await db.items.get(item.id))!.status).toBe("partial");

    // The reader is still on page index 1 after the turn; user left it on the last saved page 0.
    const r2 = reader(0);
    const second = await captureBook(db, item.id, r2.deps, { random: () => 0 });
    expect(second).toMatchObject({ state: "done", pages: 3 });
    expect(await db.units.where("jobId").equals(`${item.id}:open`).count()).toBe(3);
  });

  it("asks to reposition when the screen is not on the last saved page", async () => {
    const item = await addItem(db, { kind: "book", title: "Storm", source: "kindle:x" });
    const ac = new AbortController();
    const r = reader(0, { sleep: async () => { ac.abort(); } });
    await captureBook(db, item.id, { ...r.deps, signal: ac.signal });
    const res = await captureBook(db, item.id, reader(2).deps);
    expect(res.state).toBe("needs-reposition");
  });

  it("records a gap marker when OCR keeps failing and continues", async () => {
    const item = await addItem(db, { kind: "book", title: "Storm", source: "kindle:x" });
    const r = reader(0, { ocr: async (i) => { if (i === 1) throw new Error("ocr"); return PAGES[i]!; } });
    const res = await captureBook(db, item.id, r.deps, { random: () => 0 });
    expect(res.state).toBe("done");
    expect(res.gaps).toEqual([2]);
  });

  it("sameText tolerates OCR noise", () => {
    expect(sameText("The quick brown fox jumps over the lazy dog", "The quick brown fox jumps over the Iazy dog", 0.7)).toBe(true);
    expect(sameText("alpha beta gamma", "delta epsilon zeta")).toBe(false);
  });
});
