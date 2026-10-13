import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { chunkText, cleanOcrText, extractPdf, extractWeb, pageItemsToBlocks } from "../src";

describe("web", () => {
  it("extracts article markdown", () => {
    const html = `<html><head><title>T</title></head><body><nav>menu</nav><article><h1>Hello</h1>
      <p>${"This is a long paragraph of article text. ".repeat(10)}</p><h2>Part</h2>
      <p>${"More article content goes here. ".repeat(10)}</p></article></body></html>`;
    const r = extractWeb(new JSDOM(html).window.document)!;
    expect(r.markdown).toContain("## Part");
    expect(r.markdown).not.toContain("menu");
    expect(r.blocks.some((b) => b.type === "heading")).toBe(true);
  });
});

describe("pdf", () => {
  it("infers headings from font size", () => {
    const it = (str: string, y: number, size: number) => ({ str, transform: [size, 0, 0, size, 10, y], height: size });
    const { blocks } = pageItemsToBlocks([
      it("Chapter One", 700, 24),
      it("body line one", 650, 10),
      it("body line two", 638, 10),
      it("new paragraph", 600, 10),
    ]);
    expect(blocks.map((b) => b.type)).toEqual(["heading", "paragraph", "paragraph"]);
    expect(blocks[1]!.text).toBe("body line one body line two");
  });

  it("reads a real PDF and flags empty pages for OCR", async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const p1 = pdf.addPage();
    p1.drawText("Title Here", { x: 50, y: 700, size: 28, font });
    for (let i = 0; i < 4; i++) p1.drawText(`Body text line ${i}.`, { x: 50, y: 650 - i * 14, size: 11, font });
    pdf.addPage();
    const res = await extractPdf(await pdf.save());
    expect(res[0]!.blocks[0]).toMatchObject({ type: "heading", text: "Title Here" });
    expect(res[0]!.needsOcr).toBe(false);
    expect(res[1]!.needsOcr).toBe(true);
  });
});

describe("tts + ocr", () => {
  it("chunks on sentence boundaries with context", () => {
    const text = Array.from({ length: 20 }, (_, i) => `Sentence number ${i} is here.`).join(" ");
    const chunks = chunkText(text, 100, 20);
    expect(chunks.every((c) => c.text.length <= 100)).toBe(true);
    expect(chunks.map((c) => c.text).join(" ")).toBe(text);
    expect(chunks[1]!.previous).toBe(chunks[0]!.text.slice(-20));
  });

  it("hard-splits oversize sentences", () => {
    const chunks = chunkText("a".repeat(250), 100);
    expect(chunks.map((c) => c.text.length)).toEqual([100, 100, 50]);
  });

  it("cleans OCR wraps", () => {
    expect(cleanOcrText("one\ntwo\n\nthree")).toBe("one two\n\nthree");
  });
});
