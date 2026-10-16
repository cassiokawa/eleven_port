import type { MiddlewareHandler } from "hono";

export interface GuardOptions {
  /** If set, every request except /health must send `Authorization: Bearer <token>`. */
  token?: string;
  /** Exact origins allowed to call the API from a browser; `*` disables the check. Empty = same-origin/non-browser only. */
  allowedOrigins?: string[];
  /** Requests per window per client. */
  limit?: number;
  windowMs?: number;
  now?: () => number;
}

/**
 * Origins a local install should accept without configuration: the dev web app on any localhost port and
 * any installed Chrome extension. Websites on other origins are refused, which is what stops a page you
 * happen to visit from calling your API.
 */
export const DEFAULT_ORIGINS = ["http://localhost:*", "http://127.0.0.1:*", "chrome-extension://*"];

/** Match an Origin header against an allowlist entry: exact, "*" for anything, ":*" for any port, "*" elsewhere for any text. */
export function originMatches(pattern: string, origin: string): boolean {
  if (pattern === "*") return true;
  const re = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .reduce((acc, part, i, arr) => (i === 0 ? part : acc + (arr[i - 1]!.endsWith(":") ? "\\d+" : ".*") + part), "");
  return new RegExp(`^${re}$`).test(origin);
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** Bearer auth, CORS allowlist and a fixed-window per-client rate limit, in that order. */
export function guard(o: GuardOptions = {}): MiddlewareHandler {
  const limit = o.limit ?? 60;
  const windowMs = o.windowMs ?? 60_000;
  const now = o.now ?? Date.now;
  const hits = new Map<string, { n: number; reset: number }>();
  const origins = o.allowedOrigins ?? [];

  return async (c, next) => {
    const origin = c.req.header("origin");
    const originOk = !origin || origins.some((p) => originMatches(p, origin));
    if (origin && originOk) {
      c.header("access-control-allow-origin", origin);
      c.header("vary", "origin");
    }
    if (c.req.method === "OPTIONS") {
      if (!originOk) return c.body(null, 403);
      c.header("access-control-allow-headers", "authorization, content-type");
      c.header("access-control-allow-methods", "GET, POST, OPTIONS");
      return c.body(null, 204);
    }
    if (c.req.path === "/health") return next();
    if (!originOk) return c.json({ error: "origin not allowed" }, 403);

    if (o.token) {
      const m = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "");
      if (!m || !safeEqual(m[1]!, o.token)) return c.json({ error: "unauthorized" }, 401);
    }

    const key = c.req.header("authorization") ?? c.req.header("x-forwarded-for") ?? "anon";
    const t = now();
    // Opportunistic cleanup keeps the map bounded without a timer.
    if (hits.size > 5000) for (const [k, v] of hits) if (v.reset <= t) hits.delete(k);
    let h = hits.get(key);
    if (!h || h.reset <= t) hits.set(key, (h = { n: 0, reset: t + windowMs }));
    if (++h.n > limit) {
      c.header("retry-after", String(Math.ceil((h.reset - t) / 1000)));
      return c.json({ error: "rate limited" }, 429);
    }
    return next();
  };
}
