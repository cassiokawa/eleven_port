import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { LibraryDB, createJob, findResumable, retryFailed, runJob } from "../src";

let db: LibraryDB;
beforeEach(async () => {
  db = new LibraryDB(`t-${Math.random()}`);
  await db.open();
});

describe("jobs", () => {
  it("resumes after a crash without redoing completed units", async () => {
    const job = await createJob(db, "item1", 5);
    const seen: number[] = [];
    const ac = new AbortController();
    const first = await runJob(
      db,
      job.id,
      async (u) => {
        seen.push(u.index);
        if (u.index === 2) ac.abort();
        return `p${u.index}`;
      },
      { signal: ac.signal },
    );
    expect(first).toBe("paused");
    expect((await findResumable(db)).map((j) => j.id)).toContain(job.id);

    const seen2: number[] = [];
    const second = await runJob(db, job.id, async (u) => {
      seen2.push(u.index);
      return `p${u.index}`;
    });
    expect(second).toBe("done");
    expect(seen2).toEqual([3, 4]);
  });

  it("isolates failures per unit and retries only failed ones", async () => {
    const job = await createJob(db, "item2", 3);
    let fail = true;
    const worker = async (u: { index: number }) => {
      if (u.index === 1 && fail) throw new Error("net");
      return "ok";
    };
    expect(await runJob(db, job.id, worker, { maxAttempts: 1 })).toBe("failed");
    const units = await db.units.where("jobId").equals(job.id).sortBy("index");
    expect(units.map((u) => u.status)).toEqual(["done", "failed", "done"]);

    fail = false;
    expect(await retryFailed(db, job.id)).toBe(1);
    expect(await runJob(db, job.id, worker)).toBe("done");
  });
});
