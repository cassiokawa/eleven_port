import type { Block } from "./types";

/** Minimal Markdown to blocks parser (headings, fenced code, lists, quotes, paragraphs). */
export function parseMarkdown(src: string): Block[] {
  const blocks: Block[] = [];
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  let para: string[] = [];
  let list: string[] = [];
  let quote: string[] = [];

  const flush = () => {
    if (para.length) blocks.push({ type: "paragraph", text: para.join(" ") });
    if (list.length) blocks.push({ type: "list", text: list.join("\n") });
    if (quote.length) blocks.push({ type: "quote", text: quote.join(" ") });
    para = [];
    list = [];
    quote = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^```/.exec(line);
    if (fence) {
      flush();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i]!)) code.push(lines[i++]!);
      blocks.push({ type: "code", text: code.join("\n") });
      continue;
    }
    const h = /^(#{1,6})\s+(.*?)\s*#*$/.exec(line);
    if (h) {
      flush();
      blocks.push({ type: "heading", level: h[1]!.length, text: h[2]! });
    } else if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      if (para.length || quote.length) flush();
      list.push(line.trim());
    } else if (/^>\s?/.test(line)) {
      if (para.length || list.length) flush();
      quote.push(line.replace(/^>\s?/, ""));
    } else if (line.trim() === "") {
      flush();
    } else {
      if (list.length || quote.length) flush();
      para.push(line.trim());
    }
  }
  flush();
  return blocks;
}

export function blocksToMarkdown(blocks: Block[]): string {
  return (
    blocks
      .map((b) => {
        switch (b.type) {
          case "heading":
            return `${"#".repeat(b.level ?? 1)} ${b.text}`;
          case "code":
            return "```\n" + b.text + "\n```";
          case "quote":
            return b.text.split("\n").map((l) => `> ${l}`).join("\n");
          default:
            return b.text;
        }
      })
      .join("\n\n") + "\n"
  );
}
