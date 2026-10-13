import { describe, expect, it } from "vitest";
import { localSuggestions, refineSuggestions, type Block } from "../src";

const blocks: Block[] = [
  { type: "heading", level: 1, text: "Quantum Notes" },
  { type: "paragraph", text: "Quantum entanglement links particles. Quantum quantum entanglement entanglement." },
];
const ctx = { title: "Quantum Notes", blocks, vocabulary: ["physics"], collections: ["Science/Physics"] };

describe("refine", () => {
  it("local suggestions work offline", () => {
    const s = localSuggestions(ctx);
    expect(s.refined).toBe(false);
    expect(s.tags.length).toBeGreaterThanOrEqual(3);
    expect(s.toc).toContain("Quantum Notes");
  });

  it("replaces tags with the refined set and marks existing vocabulary", async () => {
    const local = localSuggestions(ctx);
    const f = (async () => new Response(JSON.stringify({ tags: ["physics", "quantum"], collection: "Science/Physics", summary: "s" }))) as unknown as typeof fetch;
    const r = await refineSuggestions("http://x", ctx, local, f);
    expect(r).toMatchObject({ refined: true, summary: "s", collection: "Science/Physics" });
    expect(r.tags).toEqual([{ tag: "physics", existing: true }, { tag: "quantum", existing: false }]);
  });

  it("fails fast when the API has no key so callers keep the local result", async () => {
    const f = (async () => new Response("{}", { status: 501 })) as unknown as typeof fetch;
    await expect(refineSuggestions("http://x", ctx, localSuggestions(ctx), f)).rejects.toThrow("501");
  });

  it("retries transient 429s", async () => {
    let n = 0;
    const f = (async () => (++n < 2 ? new Response("", { status: 429 }) : new Response(JSON.stringify({ tags: ["a"] })))) as unknown as typeof fetch;
    const r = await refineSuggestions("http://x", ctx, localSuggestions(ctx), f);
    expect(n).toBe(2);
    expect(r.refined).toBe(true);
  });
});
