import { buildToc, tocToMarkdown, suggestCollection, suggestTags } from "./organize";
import { blocksToMarkdown } from "./markdown";
import { withRetry } from "./retry";
import type { Block } from "./types";

export interface Suggestions {
  tags: { tag: string; existing: boolean }[];
  collection?: string;
  toc: string;
  summary?: string;
  /** True once the LLM pass has replaced the local heuristic result. */
  refined: boolean;
}

export interface SuggestContext {
  title: string;
  blocks: Block[];
  /** Tags already used elsewhere in the library. */
  vocabulary: string[];
  collections: string[];
}

/** Instant, offline suggestions from local heuristics. */
export function localSuggestions(ctx: SuggestContext): Suggestions {
  const md = blocksToMarkdown(ctx.blocks);
  return {
    tags: suggestTags(md, ctx.vocabulary).map((t) => ({ tag: t.tag, existing: t.existing })),
    collection: suggestCollection(md, ctx.collections),
    toc: tocToMarkdown(buildToc(ctx.blocks)),
    refined: false,
  };
}

class HttpError extends Error {
  constructor(readonly status: number) {
    super(`suggest failed (${status})`);
  }
}

/**
 * Ask the API to refine the local result with Claude. Retries transient failures (and waits while
 * offline), but a missing key (501) or bad request fails fast so the caller keeps the local result.
 */
export async function refineSuggestions(apiBase: string, ctx: SuggestContext, local: Suggestions, fetchImpl: typeof fetch = fetch): Promise<Suggestions> {
  const body = JSON.stringify({
    title: ctx.title,
    excerpt: blocksToMarkdown(ctx.blocks).slice(0, 6000),
    headings: ctx.blocks.filter((b) => b.type === "heading").map((b) => b.text),
    candidates: local.tags.map((t) => t.tag),
    vocabulary: ctx.vocabulary,
    collections: ctx.collections,
  });
  const res = await withRetry(
    async () => {
      const r = await fetchImpl(`${apiBase}/suggest`, { method: "POST", headers: { "content-type": "application/json" }, body });
      if (r.status === 429 || r.status === 502 || r.status === 503) throw new HttpError(r.status);
      return r;
    },
    { retries: 3 },
  );
  if (!res.ok) throw new HttpError(res.status);
  const j = (await res.json()) as { tags: string[]; collection?: string; summary?: string };
  const vocab = new Set(ctx.vocabulary.map((v) => v.toLowerCase()));
  return {
    tags: j.tags.map((tag) => ({ tag, existing: vocab.has(tag.toLowerCase()) })),
    collection: j.collection ?? local.collection,
    toc: local.toc,
    summary: j.summary,
    refined: true,
  };
}
