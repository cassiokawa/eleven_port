import type { Block } from "./types";

export interface TocEntry {
  level: number;
  title: string;
  /** Index into the blocks array. */
  blockIndex: number;
  children: TocEntry[];
}

/** Fix skipped levels (h1 -> h3 becomes h1 -> h2) and a missing top level. */
export function normalizeHeadings(blocks: Block[]): Block[] {
  const out = blocks.map((b) => ({ ...b }));
  const stack: Array<{ orig: number; norm: number }> = [];
  for (const b of out) {
    if (b.type !== "heading") continue;
    const orig = b.level ?? 1;
    while (stack.length && stack[stack.length - 1]!.orig >= orig) stack.pop();
    const norm = stack.length ? stack[stack.length - 1]!.norm + 1 : 1;
    stack.push({ orig, norm });
    b.level = Math.min(norm, 6);
  }
  return out;
}

export function buildToc(blocks: Block[]): TocEntry[] {
  const root: TocEntry[] = [];
  const stack: TocEntry[] = [];
  blocks.forEach((b, blockIndex) => {
    if (b.type !== "heading") return;
    const entry: TocEntry = { level: b.level ?? 1, title: b.text, blockIndex, children: [] };
    while (stack.length && stack[stack.length - 1]!.level >= entry.level) stack.pop();
    (stack.length ? stack[stack.length - 1]!.children : root).push(entry);
    stack.push(entry);
  });
  return root;
}

export function tocToMarkdown(toc: TocEntry[], depth = 0): string {
  return toc
    .map((e) => `${"  ".repeat(depth)}- ${e.title}\n${tocToMarkdown(e.children, depth + 1)}`)
    .join("");
}

const STOP = new Set(
  "a about above after again all also am an and any are as at be because been before being below between both but by can could did do does doing down during each few for from further had has have having he her here hers him his how i if in into is it its just me more most my no nor not now of off on once only or other our out over own same she should so some such than that the their them then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your".split(
    " ",
  ),
);

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z][a-z'-]{2,}/g) ?? []).filter((w) => !STOP.has(w));
}

export interface Keyword {
  term: string;
  score: number;
}

/** TF-IDF over parts (sections) of one item; terms concentrated in few sections score highest. */
export function keywordIndex(sections: string[], top = 20, minCount = 2): Keyword[] {
  const docs = sections.map(tokenize);
  const df = new Map<string, number>();
  const tf = new Map<string, number>();
  for (const d of docs) {
    for (const w of new Set(d)) df.set(w, (df.get(w) ?? 0) + 1);
    for (const w of d) tf.set(w, (tf.get(w) ?? 0) + 1);
  }
  const n = Math.max(docs.length, 1);
  return [...tf.entries()]
    .map(([term, f]) => ({ term, score: f * (Math.log((1 + n) / (1 + (df.get(term) ?? 0))) + 1) }))
    .filter((k) => (tf.get(k.term) ?? 0) >= minCount)
    .sort((a, b) => b.score - a.score || a.term.localeCompare(b.term))
    .slice(0, top);
}

export interface TagSuggestion {
  tag: string;
  existing: boolean;
  score: number;
}

const stem = (w: string) => w.replace(/(ing|ies|es|s)$/, (m) => (m === "ies" ? "y" : ""));

/**
 * Suggest 3-8 tags. Existing vocabulary is preferred: a keyword matching an
 * existing tag (after crude stemming) reuses that tag instead of a new one.
 */
export function suggestTags(text: string, vocabulary: string[] = [], max = 8): TagSuggestion[] {
  let kws = keywordIndex([text], 40);
  // Short texts have few repeated terms; relax the repeat threshold to reach the 3-tag floor.
  if (kws.length < 3) kws = keywordIndex([text], 40, 1);
  const byStem = new Map(vocabulary.map((t) => [stem(t.toLowerCase()), t]));
  const seen = new Set<string>();
  const out: TagSuggestion[] = [];
  for (const { term, score } of kws) {
    const existing = byStem.get(stem(term));
    const tag = existing ?? term;
    if (seen.has(tag)) continue;
    seen.add(tag);
    // Reuse of established vocabulary gets a boost so it ranks above one-off terms.
    out.push({ tag, existing: !!existing, score: existing ? score * 1.5 : score });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, Math.max(3, Math.min(max, 8)));
}

/** Suggest a collection path by overlap between item keywords and existing collection names/paths. */
export function suggestCollection(text: string, collections: string[]): string | undefined {
  const words = new Set(keywordIndex([text], 30).map((k) => stem(k.term)));
  let best: { path: string; hits: number } | undefined;
  for (const path of collections) {
    const hits = path.split("/").filter((seg) => words.has(stem(seg.toLowerCase()))).length;
    if (hits && (!best || hits > best.hits)) best = { path, hits };
  }
  return best?.path;
}
