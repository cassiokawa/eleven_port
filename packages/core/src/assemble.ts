import type { Block } from "./types";
import { parseMarkdown } from "./markdown";

/** Rejoin words hyphenated across line/page breaks: "inter-\nnational" -> "international". */
export function dehyphenate(text: string): string {
  return text.replace(/([a-z])-\s*\n\s*([a-z])/g, "$1$2");
}

/**
 * Drop the longest prefix of `next` that duplicates a suffix of `prev`
 * (overlapping screenshots/pages repeat trailing text). Minimum overlap guards
 * against accidental matches.
 */
export function trimOverlap(prev: string, next: string, minLen = 20): string {
  const max = Math.min(prev.length, next.length);
  for (let len = max; len >= minLen; len--) {
    if (prev.endsWith(next.slice(0, len))) return next.slice(len);
  }
  return next;
}

/**
 * Join per-page text into one body. A page ending without sentence-final
 * punctuation continues into the next page as the same paragraph.
 */
export function joinPages(pages: string[]): string {
  let out = "";
  for (const raw of pages) {
    const page = dehyphenate(raw).trim();
    if (!page) continue;
    if (!out) {
      out = page;
      continue;
    }
    const next = trimOverlap(out, page).trimStart();
    if (!next) continue;
    const continues = !/[.!?:"')\]]\s*$/.test(out) && !/^[#>\-*\d]/.test(next);
    out += continues ? " " + next : "\n\n" + next;
  }
  return out;
}

export function assemblePages(pages: string[]): Block[] {
  return parseMarkdown(joinPages(pages));
}
