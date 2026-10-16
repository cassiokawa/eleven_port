import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { LibraryDB, addItem, captureBook, fingerprintDistance, getParts, sameText, type PageCaptureDeps } from "../src";

let db: LibraryDB;
beforeEach(async () => {
  db = new LibraryDB(`k-${Math.random()}`);
  await db.open();
});

const PAGES = [
  "# Chapter One\n\nIt was a dark and stormy night and the rain fell in tor-",
  "rents across the old harbour town.\n\nThe lamps flickered along the quay.",
  "# Chapter Two\n\nMorning came grey and slow over the water.\n\nThe End",
];

interface Sim {
  /** Called on each turn(method); return true if this turn should take effect. */
  works?: (method: number, calls: number) => boolean;
  /** Number of sleeps after an effective turn before the new page becomes visible (slow render). */
  lag?: number;
  /** Frames shown transiently right after a turn takes effect (animation), before the real page. */
  animation?: number;
  /** Extra visual noise (e.g. a blinking cursor) added to the fingerprint without changing the text. */
  noise?: boolean;
}

function reader(startAt = 0, sim: Sim = {}, overrides: Partial<PageCaptureDeps<number>> = {}) {
  let page = startAt;
  let pending = -1;
  let lag = 0;
  let anim = 0;
  let tick = 0;
  const log = { turns: [] as number[], ocr: 0, captures: 0 };
  const deps: PageCaptureDeps<number> = {
    // Images are encoded numbers: page*10 plus a transitional marker while animating.
    capture: async () => {
      log.captures++;
      if (anim > 0) return 1000 + anim--;
      return page * 10 + (sim.noise ? tick++ % 2 : 0);
    },
    ocr: async (img) => {
      log.ocr++;
      if (img >= 1000) return "blurred mid animation";
      return PAGES[Math.floor(img / 10)]!;
    },
    fingerprint: async (img) => {
      // Animation frames each look different from one another (the picture is moving), unlike a settled page.
      if (img >= 1000) return new Uint8Array([(img - 1000) * 37 + 120, 7, 7, 7]);
      const base = Math.floor(img / 10);
      // Noise flips one cell by a visible amount; different pages differ in every cell.
      return new Uint8Array([base * 60, base * 60, base * 60, base * 60 + (img % 10 === 1 && img < 1000 ? 40 : 0)]);
    },
    turn: async (method) => {
      log.turns.push(method);
      const ok = sim.works ? sim.works(method, log.turns.length) : true;
      if (ok && page < PAGES.length - 1) {
        pending = page + 1;
        lag = sim.lag ?? 0;
        anim = sim.animation ?? 0;
        if (lag === 0) page = pending;
      }
    },
    sleep: async () => {
      if (pending >= 0 && lag > 0 && --lag === 0) page = pending;
    },
    ...overrides,
  };
  return { deps, log, get page() { return page; } };
}

const run = (r: ReturnType<typeof reader>, itemId: string, o = {}) => captureBook(db, itemId, r.deps, { random: () => 0, turnMethods: 3, ...o });

describe("captureBook: verified page turns", () => {
  it("captures to the end, stops on the end-of-book hint, rejoins hyphenation, splits chapters", async () => {
    const item = await addItem(db, { kind: "book", title: "Storm", source: "kindle:x" });
    const r = reader();
    const res = await run(r, item.id);
    expect(res).toMatchObject({ state: "done", pages: 3, gaps: [], retried: 0 });
    const parts = await getParts(db, item.id);
    expect(parts.map((p) => p.title)).toEqual(["Chapter One", "Chapter Two"]);
    expect(parts[0]!.blocks[1]!.text).toContain("torrents across the old harbour town.");
    expect((await db.items.get(item.id))!.status).toBe("complete");
    // One successful turn per page transition: no spare turns that could skip a page.
    expect(r.log.turns).toEqual([0, 0, 0]); // two real turns + one probe on the end page
  });

  it("falls back to the next turn method when the first one is ignored, and records it", async () => {
    const item = await addItem(db, { kind: "book", title: "Storm", source: "kindle:x" });
    const r = reader(0, { works: (method) => method === 1 });
    const res = await run(r, item.id);
    expect(res).toMatchObject({ state: "done", pages: 3, retried: 2 });
    expect(r.log.turns).toEqual([0, 1, 0, 1, 0]);
    const units = await db.units.where("jobId").equals(`${item.id}:open`).sortBy("index");
    expect(units.map((u) => u.meta)).toEqual([undefined, { method: 1, attempts: 2 }, { method: 1, attempts: 2 }]);
    expect(units.map((u) => u.payload).join("")).not.toContain("blurred");
  });

  it("is patient with a slow render: waits instead of turning again, so no page is skipped", async () => {
    const item = await addItem(db, { kind: "book", title: "Storm", source: "kindle:x" });
    // The page only appears after 4 sleeps. Settling takes 3 (patience wait 1 + settle frames), so it shows up within patience.
    const r = reader(0, { lag: 3 });
    const res = await run(r, item.id, { patience: 3 });
    expect(res).toMatchObject({ state: "done", pages: 3 });
    expect(r.log.turns).toEqual([0, 0, 0]);
  });

  it("never reads a frame mid-animation", async () => {
    const item = await addItem(db, { kind: "book", title: "Storm", source: "kindle:x" });
    const r = reader(0, { animation: 2 });
    const res = await run(r, item.id);
    expect(res).toMatchObject({ state: "done", pages: 3 });
    const units = await db.units.where("jobId").equals(`${item.id}:open`).toArray();
    expect(units.every((u) => !u.payload!.includes("blurred"))).toBe(true);
  });

  it("skips OCR for pixel-identical frames (nothing happened)", async () => {
    const item = await addItem(db, { kind: "book", title: "Storm", source: "kindle:x" });
    const r = reader(0, { works: (m) => m === 2 });
    const res = await run(r, item.id);
    expect(res.pages).toBe(3);
    // 3 pages + 1 OCR per effective turn; failed attempts (identical frames) cost no OCR.
    expect(r.log.ocr).toBe(3);
  });

  it("does not count visual noise (same text) as a page turn", async () => {
    const item = await addItem(db, { kind: "book", title: "Storm", source: "kindle:x" });
    const r = reader(0, { works: () => false, noise: true });
    const res = await run(r, item.id, { turnRounds: 1 });
    expect(res).toMatchObject({ state: "stalled", pages: 1 });
  });

  it("reports stalled (not done) when no turn works and the page has no end hint; partial progress is kept", async () => {
    const item = await addItem(db, { kind: "book", title: "Storm", source: "kindle:x" });
    const r = reader(0, { works: (_m, calls) => calls <= 1 }); // works once, then the reader locks up on a mid-book page
    const res = await run(r, item.id, { turnRounds: 1 });
    expect(res).toMatchObject({ state: "stalled", pages: 2 });
    expect((await db.items.get(item.id))!.status).toBe("partial");
    expect((await getParts(db, item.id)).length).toBeGreaterThan(0);
  });

  it("calls it done when it stops on an end-of-book page", async () => {
    const item = await addItem(db, { kind: "book", title: "Storm", source: "kindle:x" });
    const res = await run(reader(2), item.id, { turnRounds: 1 });
    expect(res).toMatchObject({ state: "done", pages: 1 });
  });

  it("pauses on abort with partial pages readable, then resumes without re-capturing saved pages", async () => {
    const item = await addItem(db, { kind: "book", title: "Storm", source: "kindle:x" });
    const ac = new AbortController();
    const r = reader(0);
    const first = await captureBook(db, item.id, { ...r.deps, turn: async () => { ac.abort(); }, signal: ac.signal }, { random: () => 0 });
    expect(first).toMatchObject({ state: "paused", pages: 1 });
    expect((await db.items.get(item.id))!.status).toBe("partial");

    const second = await run(reader(0), item.id);
    expect(second).toMatchObject({ state: "done", pages: 3 });
    expect(await db.units.where("jobId").equals(`${item.id}:open`).count()).toBe(3);
  });

  it("asks to reposition when the screen is not on the last saved page", async () => {
    const item = await addItem(db, { kind: "book", title: "Storm", source: "kindle:x" });
    const ac = new AbortController();
    const r = reader(0);
    await captureBook(db, item.id, { ...r.deps, turn: async () => { ac.abort(); }, signal: ac.signal }, { random: () => 0 });
    const res = await run(reader(2), item.id);
    expect(res.state).toBe("needs-reposition");
  });

  it("records a gap marker when OCR keeps failing and continues", async () => {
    const item = await addItem(db, { kind: "book", title: "Storm", source: "kindle:x" });
    const r = reader(0, {}, { ocr: async (i) => { if (i === 10) throw new Error("ocr"); return PAGES[Math.floor(i / 10)]!; } });
    const res = await run(r, item.id);
    expect(res.state).toBe("done");
    expect(res.gaps).toEqual([2]);
  });

  it("works without a fingerprint function (text check alone)", async () => {
    const item = await addItem(db, { kind: "book", title: "Storm", source: "kindle:x" });
    const r = reader(0, { works: (m) => m === 1 }, { fingerprint: undefined });
    const res = await run(r, item.id);
    expect(res).toMatchObject({ state: "done", pages: 3 });
  });

  it("does not treat the word 'end' in prose as an end-of-book page", async () => {
    const { END_HINT } = await import("../src");
    expect(END_HINT.test("At the end of the day she left.")).toBe(false);
    expect(END_HINT.test("Morning came.\n\nThe End")).toBe(true);
    expect(END_HINT.test("Before you go")).toBe(true);
  });

  it("sameText and fingerprintDistance", () => {
    expect(sameText("The quick brown fox jumps over the lazy dog", "The quick brown fox jumps over the Iazy dog", 0.7)).toBe(true);
    expect(sameText("alpha beta gamma", "delta epsilon zeta")).toBe(false);
    expect(fingerprintDistance(new Uint8Array([0, 0, 0, 0]), new Uint8Array([0, 0, 0, 0]))).toBe(0);
    expect(fingerprintDistance(new Uint8Array([0, 0, 0, 0]), new Uint8Array([200, 0, 0, 0]))).toBe(0.25);
    expect(fingerprintDistance(new Uint8Array([1, 2]), new Uint8Array([1]))).toBe(1);
  });
});
