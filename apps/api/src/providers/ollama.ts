import { SCHEMA, buildPrompt, sanitize, type SuggestInput, type SuggestOutput } from "../suggest.ts";
import type { ProviderConfig } from "./config.ts";

type Fetch = typeof fetch;

/** Raised for problems with the local server itself so the route can answer 502 with a useful message. */
export class LocalModelError extends Error {}

interface ChatOptions {
  model: string;
  content: string;
  images?: string[];
  format?: unknown;
}

async function chat(f: Fetch, cfg: ProviderConfig, o: ChatOptions): Promise<string> {
  let res: Response;
  try {
    res = await f(`${cfg.ollamaUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: o.model,
        stream: false,
        // Deterministic output: these are extraction tasks, not creative ones.
        options: { temperature: 0 },
        ...(o.format ? { format: o.format } : {}),
        messages: [{ role: "user", content: o.content, ...(o.images ? { images: o.images } : {}) }],
      }),
    });
  } catch {
    throw new LocalModelError(`Ollama unreachable at ${cfg.ollamaUrl}`);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new LocalModelError(`Ollama error ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }
  const j = (await res.json()) as { message?: { content?: string } };
  return j.message?.content ?? "";
}

/** Tag/collection suggestions from a local model. Small models drift off-schema, so retry once before giving up. */
export async function suggestOllama(f: Fetch, cfg: ProviderConfig, input: SuggestInput): Promise<SuggestOutput> {
  if (!cfg.ollamaModel) throw new LocalModelError("OLLAMA_MODEL not configured");
  let last: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const text = await chat(f, cfg, { model: cfg.ollamaModel, content: buildPrompt(input), format: SCHEMA });
    try {
      return sanitize(JSON.parse(text), input);
    } catch (e) {
      last = e;
    }
  }
  throw new LocalModelError(`model returned invalid JSON twice (${(last as Error).message})`);
}

const OCR_PROMPT =
  "Transcribe all text in this image exactly as written, in reading order. Separate paragraphs with a blank line. " +
  "Keep chapter and section titles on their own line, prefixed with # . Output only the transcription: no commentary, no descriptions of the image.";

export async function ocrOllama(f: Fetch, cfg: ProviderConfig, base64Png: string): Promise<string> {
  if (!cfg.ollamaVisionModel) throw new LocalModelError("OLLAMA_VISION_MODEL not configured");
  return (await chat(f, cfg, { model: cfg.ollamaVisionModel, content: OCR_PROMPT, images: [base64Png] })).trim();
}
