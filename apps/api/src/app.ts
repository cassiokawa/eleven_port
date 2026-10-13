import Anthropic from "@anthropic-ai/sdk";
import { Hono } from "hono";
import { parseInput, suggest, type MessagesClient } from "./suggest.ts";

export interface Deps {
  apiKey?: string;
  fetch?: typeof fetch;
  resolveHost?: (host: string) => Promise<string[]>;
  /** Override for tests; defaults to a client built from ANTHROPIC_API_KEY. */
  anthropic?: MessagesClient;
  model?: string;
}

const MAX_TTS_CHARS = 5000;
const MAX_FETCH_BYTES = 10 * 1024 * 1024;

const PRIVATE = [
  /^127\./, /^10\./, /^192\.168\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^0\./,
  /^::1$/, /^f[cd][0-9a-f]{2}:/i, /^fe80:/i,
];
export const isPrivateAddress = (ip: string) => PRIVATE.some((r) => r.test(ip));

async function defaultResolve(host: string): Promise<string[]> {
  const { lookup } = await import("node:dns/promises");
  return (await lookup(host, { all: true })).map((a) => a.address);
}

export function createApp(deps: Deps = {}) {
  const app = new Hono();
  const doFetch = deps.fetch ?? fetch;
  const resolve = deps.resolveHost ?? defaultResolve;

  app.get("/health", (c) => c.json({ ok: true }));

  // The ElevenLabs key never leaves the server.
  app.post("/tts", async (c) => {
    const key = deps.apiKey ?? process.env.ELEVENLABS_API_KEY;
    if (!key) return c.json({ error: "ELEVENLABS_API_KEY not configured" }, 500);
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.text !== "string" || typeof body.voice_id !== "string") {
      return c.json({ error: "text and voice_id required" }, 400);
    }
    if (!/^[A-Za-z0-9]{10,40}$/.test(body.voice_id)) return c.json({ error: "invalid voice_id" }, 400);
    if (body.text.length === 0 || body.text.length > MAX_TTS_CHARS) {
      return c.json({ error: `text must be 1-${MAX_TTS_CHARS} chars` }, 400);
    }
    const { voice_id, ...rest } = body;
    const res = await doFetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice_id}`, {
      method: "POST",
      headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" },
      body: JSON.stringify({ model_id: "eleven_multilingual_v2", ...rest }),
    });
    if (!res.ok) {
      // Pass through 429/5xx so the client retry queue can back off.
      return c.json({ error: "upstream error", status: res.status }, res.status === 429 ? 429 : 502);
    }
    return new Response(res.body, { headers: { "content-type": "audio/mpeg", "cache-control": "private, max-age=86400" } });
  });

  // CORS-free page fetch for the web app; blocks private/loopback targets.
  app.get("/fetch", async (c) => {
    let url: URL;
    try {
      url = new URL(c.req.query("url") ?? "");
    } catch {
      return c.json({ error: "invalid url" }, 400);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return c.json({ error: "http(s) only" }, 400);
    const addrs = /^[\d.]+$|:/.test(url.hostname) ? [url.hostname.replace(/^\[|\]$/g, "")] : await resolve(url.hostname).catch(() => []);
    if (!addrs.length || addrs.some(isPrivateAddress)) return c.json({ error: "blocked host" }, 403);

    const res = await doFetch(url, { redirect: "manual", headers: { "user-agent": "eleven-port/0.1" } });
    if (res.status >= 300 && res.status < 400) return c.json({ error: "redirects not followed", location: res.headers.get("location") }, 502);
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len > MAX_FETCH_BYTES) return c.json({ error: "too large" }, 413);
    const text = await res.text();
    if (text.length > MAX_FETCH_BYTES) return c.json({ error: "too large" }, 413);
    return c.json({ url: url.href, status: res.status, contentType: res.headers.get("content-type"), body: text });
  });

  // Optional LLM refinement of the local heuristic suggestions. The key stays server-side.
  app.post("/suggest", async (c) => {
    const input = parseInput(await c.req.json().catch(() => null));
    if (!input) return c.json({ error: "title and excerpt required" }, 400);
    const client = deps.anthropic ?? (process.env.ANTHROPIC_API_KEY ? new Anthropic() : undefined);
    if (!client) return c.json({ error: "ANTHROPIC_API_KEY not configured" }, 501);
    try {
      return c.json(await suggest(client, input, deps.model ?? process.env.ANTHROPIC_MODEL ?? "claude-opus-5-5"));
    } catch (e) {
      if (e instanceof Anthropic.RateLimitError) return c.json({ error: "rate limited" }, 429);
      if (e instanceof Anthropic.APIConnectionError) return c.json({ error: "upstream unreachable" }, 502);
      if (e instanceof Anthropic.APIError) return c.json({ error: "upstream error", status: e.status }, 502);
      return c.json({ error: (e as Error).message }, 502);
    }
  });

  return app;
}
