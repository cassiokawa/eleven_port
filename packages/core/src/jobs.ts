import type { LibraryDB } from "./store";
import type { Job, JobState, Unit } from "./types";

export interface UnitWorker {
  /** Process one unit and return its payload. May throw; failure is per-unit. */
  (unit: Unit, signal: AbortSignal): Promise<string>;
}

export interface RunOptions {
  maxAttempts?: number;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

export async function createJob(
  db: LibraryDB,
  itemId: string,
  total: number,
  now = Date.now(),
): Promise<Job> {
  const job: Job = {
    id: `${itemId}:${now}`,
    itemId,
    state: "queued",
    total,
    createdAt: now,
    updatedAt: now,
  };
  const units: Unit[] = Array.from({ length: total }, (_, index) => ({
    id: `${job.id}:${index}`,
    jobId: job.id,
    index,
    status: "pending",
    attempts: 0,
  }));
  await db.transaction("rw", db.jobs, db.units, async () => {
    await db.jobs.put(job);
    await db.units.bulkPut(units);
  });
  return job;
}

async function setState(db: LibraryDB, id: string, state: JobState, error?: string) {
  await db.jobs.update(id, { state, error, updatedAt: Date.now() });
}

/**
 * Run (or resume) a job. Only pending units, and failed units under the
 * attempt cap, are processed; completed units are never redone.
 * Each unit result is persisted before moving on (checkpoint).
 */
export async function runJob(
  db: LibraryDB,
  jobId: string,
  worker: UnitWorker,
  opts: RunOptions = {},
): Promise<JobState> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const ac = new AbortController();
  opts.signal?.addEventListener("abort", () => ac.abort());
  await setState(db, jobId, "capturing");

  const all = await db.units.where("jobId").equals(jobId).sortBy("index");
  let done = all.filter((u) => u.status === "done").length;

  for (const unit of all) {
    if (ac.signal.aborted) {
      await setState(db, jobId, "paused");
      return "paused";
    }
    if (unit.status === "done" || unit.attempts >= maxAttempts) continue;
    try {
      const payload = await worker(unit, ac.signal);
      await db.units.update(unit.id, {
        status: "done",
        payload,
        attempts: unit.attempts + 1,
        error: undefined,
      });
      done++;
      opts.onProgress?.(done, all.length);
    } catch (e) {
      if (ac.signal.aborted) {
        await setState(db, jobId, "paused");
        return "paused";
      }
      await db.units.update(unit.id, {
        status: "failed",
        attempts: unit.attempts + 1,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const final = await db.units.where("jobId").equals(jobId).toArray();
  const allDone = final.every((u) => u.status === "done");
  const state: JobState = allDone ? "done" : "failed";
  await setState(db, jobId, state, allDone ? undefined : "some units failed");
  return state;
}

/** Jobs left mid-flight by a crash/close; call on startup, then runJob each. */
export async function findResumable(db: LibraryDB): Promise<Job[]> {
  return db.jobs
    .where("state")
    .anyOf("queued", "capturing", "ocr", "assembling", "paused", "failed")
    .toArray();
}

/** Reset failed units so a re-run retries only them. */
export async function retryFailed(db: LibraryDB, jobId: string): Promise<number> {
  const failed = await db.units.where({ jobId, status: "failed" }).toArray();
  await db.units.bulkPut(failed.map((u) => ({ ...u, status: "pending", attempts: 0 })));
  return failed.length;
}

/** Get or create the open-ended job for an item (unknown page count, e.g. a book being captured). */
export async function createJobOpen(db: LibraryDB, itemId: string, now = Date.now()): Promise<Job> {
  const id = `${itemId}:open`;
  const existing = await db.jobs.get(id);
  if (existing) return existing;
  const job: Job = { id, itemId, state: "queued", createdAt: now, updatedAt: now };
  await db.jobs.put(job);
  return job;
}
