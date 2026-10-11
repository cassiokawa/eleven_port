import { describe, expect, it } from "vitest";
import { assemblePages, blocksToMarkdown, dehyphenate, parseMarkdown, trimOverlap } from "../src";

describe("assemble", () => {
  it("dehyphenates", () => {
    expect(dehyphenate("inter-\nnational")).toBe("international");
  });

  it("trims overlapping page text", () => {
    const prev = "The quick brown fox jumps over the lazy dog.";
    expect(trimOverlap(prev, "jumps over the lazy dog. Next sentence.")).toBe(" Next sentence.");
  });

  it("joins a paragraph split across pages", () => {
    const blocks = assemblePages(["# Ch 1\n\nThe story begins in a small", "village by the sea.\n\nSecond para."]);
    expect(blocks.map((b) => b.type)).toEqual(["heading", "paragraph", "paragraph"]);
    expect(blocks[1]!.text).toBe("The story begins in a small village by the sea.");
  });

  it("round-trips markdown", () => {
    const md = "# T\n\nHello world.\n\n```\ncode\n```\n";
    expect(blocksToMarkdown(parseMarkdown(md))).toBe(md);
  });
});
