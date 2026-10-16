import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import { parseMarkdown } from "../markdown";
import type { Block } from "../types";

export interface WebExtraction {
  title: string;
  author?: string;
  markdown: string;
  blocks: Block[];
}

/** Extract the main article from a DOM Document (live page or parsed HTML) into Markdown. */
export function extractWeb(doc: Document): WebExtraction | null {
  const article = new Readability(doc.cloneNode(true) as Document).parse();
  if (!article?.content) return null;
  const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
  const markdown = td.turndown(article.content).trim() + "\n";
  return {
    title: article.title || doc.title || "Untitled",
    author: article.byline || undefined,
    markdown,
    blocks: parseMarkdown(markdown),
  };
}
