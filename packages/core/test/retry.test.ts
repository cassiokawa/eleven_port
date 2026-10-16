import { describe, expect, it } from "vitest";
import { withRetry } from "../src";

describe("withRetry", () => {
  it("retries then succeeds", async () => {
    let n = 0;
    const r = await withRetry(
      async () => {
        if (++n < 3) throw new Error("x");
        return "ok";
      },
      { sleep: async () => {} },
    );
    expect(r).toBe("ok");
    expect(n).toBe(3);
  });

  it("parks while offline without consuming attempts", async () => {
    let online = false;
    let calls = 0;
    const p = withRetry(async () => ++calls, {
      isOnline: () => online,
      waitOnline: async () => {
        online = true;
      },
    });
    expect(await p).toBe(1);
  });

  it("gives up after retries", async () => {
    await expect(
      withRetry(async () => { throw new Error("no"); }, { retries: 2, sleep: async () => {} }),
    ).rejects.toThrow("no");
  });
});
