import Anthropic from "@anthropic-ai/sdk";

export interface SuggestInput {
  title: string;
  /** Opening excerpt of the text (the caller trims; this module caps it again). */
  excerpt: string;
  headings: string[];
  /** Tags the local heuristic proposed, best first. */
  candidates: string[];
  /** Every tag already in the library, so the model reuses them. */
  vocabulary: string[];
  /** Existing collection paths. */
  collections: string[];
}

export interface SuggestOutput {
  tags: string[];
  collection?: string;
  summary: string;
}

const MAX_EXCERPT = 6000;
const MAX_LIST = 200;

const SCHEMA = {
  type: "object",
  properties: {
    tags: { type: "array", items: { type: "string" } },
    collection: { type: "string" },
    summary: { type: "string" },
  },
  required: ["tags", "collection", "summary"],
  additionalProperties: false,
} as const;

export function parseInput(body: unknown): SuggestInput | undefined {
  if (!body || typeof body !== "object") return undefined;
  const b = body as Record<string, unknown>;
  const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, MAX_LIST) : []);
  if (typeof b.title !== "string" || typeof b.excerpt !== "string") return undefined;
  return {
    title: b.title.slice(0, 300),
    excerpt: b.excerpt.slice(0, MAX_EXCERPT),
    headings: strs(b.headings),
    candidates: strs(b.candidates),
    vocabulary: strs(b.vocabulary),
    collections: strs(b.collections),
  };
}

/** Clamp model output to the contract the UI relies on, whatever the model returns. */
export function sanitize(raw: unknown, input: SuggestInput): SuggestOutput {
  const r = (raw ?? {}) as Partial<SuggestOutput>;
  const vocab = new Map(input.vocabulary.map((t) => [t.toLowerCase(), t]));
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const t of Array.isArray(r.tags) ? r.tags : []) {
    if (typeof t !== "string") continue;
    const clean = t.trim().slice(0, 40);
    // Snap near-duplicates onto existing vocabulary, case-insensitively.
    const final = vocab.get(clean.toLowerCase()) ?? clean;
    if (final && !seen.has(final.toLowerCase())) {
      seen.add(final.toLowerCase());
      tags.push(final);
    }
    if (tags.length === 8) break;
  }
  const collection = typeof r.collection === "string" && r.collection.trim() ? r.collection.trim().slice(0, 120) : undefined;
  return { tags, collection, summary: typeof r.summary === "string" ? r.summary.slice(0, 500) : "" };
}

export function buildPrompt(i: SuggestInput): string {
  return [
    "Suggest organization metadata for a captured document in a personal reading library.",
    "Rules: 3 to 8 short lowercase tags. Reuse a tag from the existing vocabulary whenever one fits instead of inventing a near-duplicate.",
    "Collection: choose an existing collection path if one fits, otherwise propose a new Folder/Subfolder path (at most 3 levels), or an empty string if none fits.",
    "Summary: one sentence.",
    "",
    `Title: ${i.title}`,
    `Headings: ${i.headings.slice(0, 40).join(" | ") || "(none)"}`,
    `Heuristic tag candidates: ${i.candidates.join(", ") || "(none)"}`,
    `Existing tag vocabulary: ${i.vocabulary.join(", ") || "(none)"}`,
    `Existing collections: ${i.collections.join(", ") || "(none)"}`,
    "",
    "<excerpt>",
    i.excerpt,
    "</excerpt>",
  ].join("\n");
}

export type MessagesClient = Pick<Anthropic, "beta">;

export async function suggest(client: MessagesClient, input: SuggestInput, model = "claude-opus-5-5"): Promise<SuggestOutput> {
  const res = await client.beta.messages.create({
    model,
    max_tokens: 2000,
    // Server-side fallback if the safety classifiers decline; "default" routes by refusal category.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    // Simple labeling task: low effort keeps latency and cost down on a model that always thinks.
    output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA as unknown as Record<string, unknown> } },
    messages: [{ role: "user", content: buildPrompt(input) }],
  });
  if (res.stop_reason === "refusal") throw new Error("model declined to answer");
  const text = res.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") throw new Error("no text in model response");
  return sanitize(JSON.parse(text.text), input);
}
