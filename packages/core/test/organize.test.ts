import { describe, expect, it } from "vitest";
import { buildToc, keywordIndex, normalizeHeadings, suggestCollection, suggestTags, tocToMarkdown, type Block } from "../src";

const h = (level: number, text: string): Block => ({ type: "heading", level, text });

describe("organize", () => {
  it("normalizes skipped heading levels", () => {
    const out = normalizeHeadings([h(2, "A"), h(4, "B"), h(4, "C"), h(2, "D")]);
    expect(out.map((b) => b.level)).toEqual([1, 2, 2, 1]);
  });

  it("builds a nested TOC", () => {
    const toc = buildToc([h(1, "Book"), { type: "paragraph", text: "x" }, h(2, "Ch1"), h(3, "S1"), h(2, "Ch2")]);
    expect(toc).toHaveLength(1);
    expect(toc[0]!.children.map((c) => c.title)).toEqual(["Ch1", "Ch2"]);
    expect(tocToMarkdown(toc)).toBe("- Book\n  - Ch1\n    - S1\n  - Ch2\n");
  });

  it("ranks section-specific terms in the keyword index", () => {
    const k = keywordIndex(["quantum quantum quantum quantum entanglement entanglement the cat", "the cat the cat sat sat"]);
    expect(k[0]!.term).toMatch(/quantum|entanglement/);
  });

  it("reuses existing tag vocabulary instead of inventing near-duplicates", () => {
    const text = "Quantum entanglement links particles. Entanglement experiments test quantum theory. Quantum quantum.";
    const tags = suggestTags(text, ["Quantum", "Cooking"]);
    expect(tags.find((t) => t.tag === "Quantum")?.existing).toBe(true);
    expect(tags.some((t) => t.tag === "quantum")).toBe(false);
    expect(tags.length).toBeGreaterThanOrEqual(3);
  });

  it("suggests an existing collection path", () => {
    const text = "physics physics quantum quantum particle particle";
    expect(suggestCollection(text, ["Cooking/Italian", "Science/Physics/Quantum"])).toBe("Science/Physics/Quantum");
  });
});
