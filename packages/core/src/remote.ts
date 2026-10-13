import type { Ocr, OcrSource } from "./extract/ocr";

export interface ServerConfig {
  llm: "anthropic" | "ollama";
  llmConfigured: boolean;
  tts: "elevenlabs" | "local";
  ttsConfigured: boolean;
  ocr: ("tesseract" | "local-vision")[];
}

const authHeader = (token?: string): Record<string, string> => (token ? { authorization: `Bearer ${token}` } : {});

/** Which engines the API is using. Resolves undefined (never throws) when the API is unreachable or old. */
export async function fetchServerConfig(apiBase: string, token?: string, fetchImpl: typeof fetch = fetch): Promise<ServerConfig | undefined> {
  try {
    const r = await fetchImpl(`${apiBase}/config`, { headers: authHeader(token) });
    return r.ok ? ((await r.json()) as ServerConfig) : undefined;
  } catch {
    return undefined;
  }
}

async function toDataUrl(img: OcrSource): Promise<string | undefined> {
  if (typeof img === "string") return img.startsWith("data:image/") ? img : undefined;
  if (typeof HTMLCanvasElement !== "undefined" && img instanceof HTMLCanvasElement) return img.toDataURL("image/png");
  if (typeof Blob !== "undefined" && img instanceof Blob) {
    return new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result as string);
      fr.onerror = () => rej(fr.error);
      fr.readAsDataURL(img);
    });
  }
  return undefined;
}

export interface RemoteOcrOptions {
  token?: string;
  /** Used when the local vision model is unreachable, errors, or the input cannot be sent. Created lazily. */
  fallback?: () => Promise<Ocr>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * OCR through the API's local vision model (`POST /ocr`). Slow models are common, so there is a generous
 * timeout; any failure falls back to the bundled engine so a page is only lost if both fail.
 */
export function createRemoteOcr(apiBase: string, o: RemoteOcrOptions = {}): Ocr {
  const f = o.fetchImpl ?? fetch;
  let fb: Promise<Ocr> | undefined;
  const fallback = () => (o.fallback ? (fb ??= o.fallback()) : undefined);

  return {
    async recognize(img) {
      try {
        const image = await toDataUrl(img);
        if (!image) throw new Error("unsupported image type");
        const r = await f(`${apiBase}/ocr`, {
          method: "POST",
          headers: { "content-type": "application/json", ...authHeader(o.token) },
          body: JSON.stringify({ image }),
          signal: AbortSignal.timeout(o.timeoutMs ?? 180_000),
        });
        if (!r.ok) throw new Error(`ocr ${r.status}`);
        const { text } = (await r.json()) as { text: string };
        return text;
      } catch (e) {
        const engine = fallback();
        if (!engine) throw e;
        return (await engine).recognize(img);
      }
    },
    async terminate() {
      if (fb) await (await fb).terminate();
    },
  };
}
