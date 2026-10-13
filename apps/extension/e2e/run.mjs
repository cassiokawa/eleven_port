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

// Stub of apps/api for the local-vision path: call 1 and 3+ answer, call 2 fails so the per-page fallback to Tesseract is exercised.
let ocrCalls = 0;
const api = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/config") return res.end(JSON.stringify({ llm: "ollama", llmConfigured: true, tts: "local", ttsConfigured: true, ocr: ["tesseract", "local-vision"] }));
    if (req.url === "/ocr") {
      const n = ++ocrCalls;
      if (!JSON.parse(body).image?.startsWith("data:image/png;base64,")) return res.writeHead(400).end("{}");
      if (n === 2) return res.writeHead(502).end("{}");
      return res.end(JSON.stringify({ text: n === 1 ? "STUB PAGE ONE\n\nread by the local vision model." : "STUB PAGE THREE\n\nalso read by the local vision model." }));
    }
    res.writeHead(404).end("{}");
  });
}).listen(0);
const apiBase = `http://localhost:${api.address().port}`;

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

  // 3. Local vision OCR via the API, with per-page fallback to the bundled engine.
  const rd2 = await ctx.newPage();
  await rd2.goto(base + "/reader");
  const panel3 = await ctx.newPage();
  await panel3.goto(`chrome-extension://${extId}/sidepanel.html?targetTab=${await tabId(rd2)}`);
  await panel3.evaluate((a) => chrome.storage.local.set({ api: a, ocrEngine: "local-vision" }), apiBase);
  await panel3.reload();
  await panel3.getByText("Server: suggestions ollama, narration local").waitFor({ state: "attached", timeout: 15000 }).catch(() => {});
  await panel3.getByRole("button", { name: "Capture book (Kindle)" }).click();
  await panel3.getByText(/^Done: \d+ pages/).waitFor({ timeout: 240000 });
  const payloads = await panel3.evaluate(async () => {
    const req = indexedDB.open("eleven-port");
    const db = await new Promise((r) => (req.onsuccess = () => r(req.result)));
    const q = db.transaction("units").objectStore("units").getAll();
    return new Promise((r) => (q.onsuccess = () => r(q.result.filter((u) => u.jobId.includes(":open")).map((u) => u.payload))));
  });
  const vision = payloads.filter((t) => /STUB PAGE/.test(t));
  check("local vision pages used the API", vision.length === 2, `(${vision.length} stub pages, ${ocrCalls} calls)`);
  check("failed vision page fell back to Tesseract", payloads.some((t) => /stars|harbour/i.test(t) && !/STUB/.test(t)));
} catch (e) {
  console.log("FAIL exception", e);
  failed++;
} finally {
  await ctx.close();
  server.close();
  api.close();
}
process.exit(failed ? 1 : 0);
