import { runJob, type UnitWorker } from "./jobs";
import type { LibraryDB } from "./store";
import type { Item, Job, JobState } from "./types";

const RESUMABLE: JobState[] = ["queued", "capturing", "ocr", "assembling", "paused"];

/**
 * On startup, continue jobs a crash or closed tab left mid-flight. `makeWorker`
 * rebuilds the unit worker for an item (e.g. reopen the stored PDF); return
 * undefined to skip a job that cannot be resumed. Failed jobs are not retried
 * automatically; the user retries those explicitly.
 */
export async function resumeInterrupted(
  db: LibraryDB,
  makeWorker: (item: Item, job: Job) => Promise<UnitWorker | undefined>,
): Promise<{ resumed: string[]; skipped: string[] }> {
  const jobs = await db.jobs.where("state").anyOf(RESUMABLE).toArray();
  const resumed: string[] = [];
  const skipped: string[] = [];
  for (const job of jobs) {
    const item = await db.items.get(job.itemId);
    const worker = item ? await makeWorker(item, job).catch(() => undefined) : undefined;
    if (!worker) {
      skipped.push(job.id);
      continue;
    }
    await runJob(db, job.id, worker, { maxAttempts: 1 });
    resumed.push(job.id);
  }
  return { resumed, skipped };
}
