import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { article, reader } from "./fixtures.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH ?? "playwright");

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const server = createServer((req, res) => {
  res.setHeader("content-type", "text/html");
  res.end(req.url?.startsWith("/reader") ? reader : article);
}).listen(0);
const base = `http://localhost:${server.address().port}`;

const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "ep-")), {
  executablePath: process.env.CHROMIUM_PATH,
  headless: false,
  args: ["--headless=new", `--disable-extensions-except=${dist}`, `--load-extension=${dist}`, "--no-sandbox"],
  viewport: { width: 1100, height: 800 },
});
let failed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name} ${extra}`); if (!ok) failed++; };

try {
  let [sw] = ctx.serviceWorkers();
  sw ??= await ctx.waitForEvent("serviceworker", { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  const tabId = async (page) => sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url?.startsWith(u))?.id, page.url());

  // 1. DOM capture of a web article.
  const art = await ctx.newPage();
  await art.goto(base + "/article");
  const panel = await ctx.newPage();
  await panel.goto(`chrome-extension://${extId}/sidepanel.html?targetTab=${await tabId(art)}`);
  await panel.getByRole("button", { name: "Capture page" }).click();
  await panel.getByText("Harbour Notes").first().waitFor({ timeout: 15000 });
  check("web capture creates library item", (await panel.locator("li").count()) === 1);

  // 2. Kindle-style capture: screenshot + OCR + page turn, with pause/resume.
  const rd = await ctx.newPage();
  await rd.goto(base + "/reader");
  const panel2 = await ctx.newPage();
  await panel2.goto(`chrome-extension://${extId}/sidepanel.html?targetTab=${await tabId(rd)}`);
  await panel2.getByRole("button", { name: "Capture book (Kindle)" }).click();
  await panel2.getByText(/^Done: \d+ pages/).waitFor({ timeout: 240000 });
  const doneText = await panel2.getByText(/^Done: \d+ pages/).textContent();
  check("book capture completes", /Done: 3 pages/.test(doneText ?? ""), `(${doneText})`);

  const md = await panel2.evaluate(async () => {
    const req = indexedDB.open("eleven-port");
    const db = await new Promise((r) => (req.onsuccess = () => r(req.result)));
    const tx = db.transaction("parts");
    const all = await new Promise((r) => { const q = tx.objectStore("parts").getAll(); q.onsuccess = () => r(q.result); });
    return JSON.stringify(all);
  });
  const units = await panel2.evaluate(async () => {
    const req = indexedDB.open("eleven-port");
    const db = await new Promise((r) => (req.onsuccess = () => r(req.result)));
    const q = db.transaction("units").objectStore("units").getAll();
    return new Promise((r) => (q.onsuccess = () => r(q.result.map((u) => u.payload))));
  });
  console.log("UNITS", JSON.stringify(units));
  check("OCR text reached the library", /lighthouse/i.test(md) && /fog|morning/i.test(md));
  check("chapters detected", /CHAPTER (ONE|TWO)/i.test(md));
} catch (e) {
  console.log("FAIL exception", e);
  failed++;
} finally {
  await ctx.close();
  server.close();
}
process.exit(failed ? 1 : 0);
