export interface RetryOptions {
  retries?: number;
  baseMs?: number;
  maxMs?: number;
  sleep?: (ms: number) => Promise<void>;
  isOnline?: () => boolean;
  waitOnline?: () => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function defaultOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

function defaultWaitOnline(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  return new Promise((r) => window.addEventListener("online", () => r(), { once: true }));
}

/** Exponential backoff with full jitter; parks while offline instead of burning attempts. */
export async function withRetry<T>(fn: () => Promise<T>, o: RetryOptions = {}): Promise<T> {
  const retries = o.retries ?? 5;
  const base = o.baseMs ?? 500;
  const max = o.maxMs ?? 30_000;
  const sleep = o.sleep ?? defaultSleep;
  const online = o.isOnline ?? defaultOnline;
  const waitOnline = o.waitOnline ?? defaultWaitOnline;

  for (let attempt = 0; ; attempt++) {
    if (!online()) await waitOnline();
    try {
      return await fn();
    } catch (e) {
      if (attempt >= retries) throw e;
      const cap = Math.min(max, base * 2 ** attempt);
      await sleep(Math.random() * cap);
    }
  }
}
