import Anthropic from "@anthropic-ai/sdk";
import { Hono } from "hono";
import { DEFAULT_ORIGINS, guard, type GuardOptions } from "./guard.ts";
import { readConfig, type ProviderConfig } from "./providers/config.ts";
import { LocalModelError, ocrOllama, suggestOllama } from "./providers/ollama.ts";
import { ttsElevenLabs, ttsLocal, type TtsBody } from "./providers/tts.ts";
import { parseInput, suggest, type MessagesClient } from "./suggest.ts";

export interface Deps {
  apiKey?: string;
  fetch?: typeof fetch;
  resolveHost?: (host: string) => Promise<string[]>;
  /** Override for tests; defaults to a client built from ANTHROPIC_API_KEY. */
  anthropic?: MessagesClient;
  model?: string;
  guard?: GuardOptions;
  /** Provider selection; defaults to environment variables. */
  config?: Partial<ProviderConfig>;
}

const MAX_TTS_CHARS = 5000;
const MAX_FETCH_BYTES = 10 * 1024 * 1024;
const MAX_OCR_BYTES = 8 * 1024 * 1024;

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
  app.use(
    "*",
    guard({
      token: process.env.API_TOKEN,
      allowedOrigins: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_ORIGINS,
      ...deps.guard,
    }),
  );
  const cfg: ProviderConfig = { ...readConfig(), ...deps.config };
  const doFetch = deps.fetch ?? fetch;
  const resolve = deps.resolveHost ?? defaultResolve;

  app.get("/health", (c) => c.json({ ok: true }));

  // Provider keys and local server URLs never leave the server.
  app.post("/tts", async (c) => {
    const key = deps.apiKey ?? process.env.ELEVENLABS_API_KEY;
    if (cfg.tts === "elevenlabs" && !key) return c.json({ error: "ELEVENLABS_API_KEY not configured" }, 500);
    if (cfg.tts === "local" && !cfg.localTtsUrl) return c.json({ error: "LOCAL_TTS_URL not configured" }, 500);
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.text !== "string" || typeof body.voice_id !== "string") {
      return c.json({ error: "text and voice_id required" }, 400);
    }
    // ElevenLabs ids are alphanumeric; local engines name voices like "af_bella", so allow a wider but still path-safe set.
    const voiceOk = cfg.tts === "local" ? /^[\w.-]{1,64}$/.test(body.voice_id) : /^[A-Za-z0-9]{10,40}$/.test(body.voice_id);
    if (!voiceOk) return c.json({ error: "invalid voice_id" }, 400);
    if (body.text.length === 0 || body.text.length > MAX_TTS_CHARS) {
      return c.json({ error: `text must be 1-${MAX_TTS_CHARS} chars` }, 400);
    }
    const vs = body.voice_settings;
    if (vs !== undefined) {
      const ok = vs && typeof vs === "object" && Object.values(vs).every((v) => typeof v === "number" && v >= 0 && v <= 1);
      if (!ok) return c.json({ error: "voice_settings values must be numbers in [0,1]" }, 400);
    }
    const r = cfg.tts === "local" ? await ttsLocal(doFetch, cfg, body as TtsBody) : await ttsElevenLabs(doFetch, key!, body as TtsBody);
    if (!r.ok) {
      // Pass through 429/5xx so the client retry queue can back off.
      return c.json({ error: "upstream error", status: r.status }, r.status === 429 ? 429 : 502);
    }
    return new Response(r.body, { headers: { "content-type": r.contentType, "cache-control": "private, max-age=86400" } });
  });

  // Which engines are active, so UIs can show them and hide ElevenLabs-only controls. No secrets.
  app.get("/config", (c) =>
    c.json({
      llm: cfg.llm,
      llmConfigured: cfg.llm === "ollama" ? !!cfg.ollamaModel : !!(deps.anthropic || process.env.ANTHROPIC_API_KEY),
      tts: cfg.tts,
      ttsConfigured: cfg.tts === "local" ? !!cfg.localTtsUrl : !!(deps.apiKey ?? process.env.ELEVENLABS_API_KEY),
      ocr: cfg.ollamaVisionModel ? ["tesseract", "local-vision"] : ["tesseract"],
    }),
  );

  // OCR with a local vision model, for users who prefer it over the bundled Tesseract.
  app.post("/ocr", async (c) => {
    if (!cfg.ollamaVisionModel) return c.json({ error: "OLLAMA_VISION_MODEL not configured" }, 501);
    const body = await c.req.json().catch(() => null);
    const m = typeof body?.image === "string" ? /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(body.image) : null;
    if (!m) return c.json({ error: "image must be a base64 data URL (png, jpeg or webp)" }, 400);
    if (m[1]!.length > MAX_OCR_BYTES) return c.json({ error: "image too large" }, 413);
    try {
      return c.json({ text: await ocrOllama(doFetch, cfg, m[1]!) });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 502);
    }
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
    if (cfg.llm === "ollama") {
      if (!cfg.ollamaModel) return c.json({ error: "OLLAMA_MODEL not configured" }, 501);
      try {
        return c.json(await suggestOllama(doFetch, cfg, input));
      } catch (e) {
        if (e instanceof LocalModelError) return c.json({ error: e.message }, 502);
        throw e;
      }
    }
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
