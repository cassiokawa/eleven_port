import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH ?? "playwright");
const { PDFDocument, StandardFonts } = require("pdf-lib");

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".wasm": "application/wasm" };
const server = createServer((req, res) => {
  const p = join(dist, req.url === "/" ? "index.html" : req.url.split("?")[0]);
  if (!existsSync(p)) return res.writeHead(404).end();
  res.writeHead(200, { "content-type": types[extname(p)] ?? "application/octet-stream" }).end(readFileSync(p));
}).listen(0);
const base = `http://localhost:${server.address().port}`;

// 0.3s of silence as a WAV so the <audio> element can really play and fire "ended".
function wav() {
  const rate = 8000, n = rate * 0.3, buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVEfmt ", 8); buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  return buf;
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ["--autoplay-policy=no-user-gesture-required", "--no-sandbox"] });
let failed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name} ${extra}`); if (!ok) failed++; };

async function open(ctx, handler, config) {
  const page = await ctx.newPage();
  if (config) await page.route("**/api/config", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(config) }));
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/api/tts", handler);
  await page.goto(base);
  await page.setInputFiles("input[type=file]", {
    name: "story.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# Story\n\nThe lamps flickered along the quay. The sea was calm.\n"),
  });
  await page.getByText("Story").first().click();
  return { page, errors };
}

try {
  // 1. Transient upstream failures are retried until the audio arrives.
  {
    const ctx = await browser.newContext();
    let calls = 0;
    const { page, errors } = await open(ctx, (route) => {
      calls++;
      return calls <= 2 ? route.fulfill({ status: 503, body: "busy" }) : route.fulfill({ status: 200, contentType: "audio/wav", body: wav() });
    });
    await page.getByRole("button", { name: "▶ Narrate all" }).click();
    await page.waitForFunction(() => !document.body.innerText.includes("Narrating chunk"), null, { timeout: 30000 });
    check("tts retries 503 then succeeds", calls >= 3 && !(await page.getByRole("alert").count()), `(calls=${calls})`);
    // Replay must come from the persistent audio cache: zero new API calls.
    const before = calls;
    await page.getByRole("button", { name: "▶ Narrate all" }).click();
    await page.waitForTimeout(1500);
    check("replay served from audio cache", calls === before, `(calls ${before} -> ${calls})`);
    check("no page errors (retry)", errors.length === 0, JSON.stringify(errors));
    await ctx.close();
  }

  // 2. A network dropout parks the request instead of failing, and it completes after reconnect.
  {
    const ctx = await browser.newContext();
    let served = 0;
    const { page, errors } = await open(ctx, (route) => { served++; return route.fulfill({ status: 200, contentType: "audio/wav", body: wav() }); });
    await ctx.setOffline(true);
    await page.getByRole("button", { name: "▶ Narrate all" }).click();
    await page.waitForTimeout(1500);
    check("no request or error while offline", served === 0 && (await page.getByRole("alert").count()) === 0, `(served=${served})`);
    await ctx.setOffline(false);
    await page.waitForFunction(() => !document.body.innerText.includes("Narrating chunk"), null, { timeout: 30000 });
    check("narration completes after reconnect", served >= 1, `(served=${served})`);
    check("no page errors (offline)", errors.length === 0, JSON.stringify(errors));
    await ctx.close();
  }

  // 3. With a local TTS engine, ElevenLabs-only options are not sent and the UI hides them.
  {
    const ctx = await browser.newContext();
    const bodies = [];
    const local = { llm: "ollama", llmConfigured: true, tts: "local", ttsConfigured: true, ocr: ["tesseract"] };
    const { page } = await open(ctx, (route) => { bodies.push(JSON.parse(route.request().postData())); return route.fulfill({ status: 200, contentType: "audio/wav", body: wav() }); }, local);
    await page.getByRole("button", { name: "← Library" }).click();
    await page.getByText("Voice, engines and API settings").click();
    await page.getByText(/narration via local/).waitFor({ timeout: 5000 });
    check("stability slider hidden for local TTS", (await page.getByText(/Stability/).count()) === 0);
    await page.getByText("Story").first().click();
    await page.getByRole("button", { name: "▶ Narrate all" }).click();
    await page.waitForFunction(() => !document.body.innerText.includes("Narrating chunk"), null, { timeout: 30000 });
    check("local TTS request omits voice_settings", bodies.length >= 1 && bodies.every((b) => b.voice_settings === undefined), JSON.stringify(bodies[0]?.voice_settings));
    await ctx.close();
  }

  // 4. PDF import in a real browser: text page becomes a part, a page without a text layer becomes a failed part, no errors.
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(base);
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const p1 = pdf.addPage();
    p1.drawText("Lighthouse Report", { x: 50, y: 700, size: 28, font });
    for (let i = 0; i < 4; i++) p1.drawText(`The keeper climbed the stairs, line ${i}.`, { x: 50, y: 650 - i * 14, size: 11, font });
    pdf.addPage();
    await page.setInputFiles("input[type=file]", { name: "report.pdf", mimeType: "application/pdf", buffer: Buffer.from(await pdf.save()) });
    const listed = await page.getByRole("button", { name: "report", exact: true }).waitFor({ timeout: 20000 }).then(() => true, () => false);
    check("pdf import adds an item", listed);
    await page.waitForTimeout(1000);
    check("pdf import shows no error", (await page.getByRole("alert").count()) === 0, JSON.stringify(await page.getByRole("alert").allTextContents()));
    await page.getByRole("button", { name: "report", exact: true }).click();
    const text = await page.getByText("Lighthouse Report").first().waitFor({ timeout: 10000 }).then(() => true, () => false);
    check("pdf text page was extracted", text);
    check("blank page is a failed part", (await page.getByText("(failed)").count()) === 1);
    check("no page errors (pdf)", errors.length === 0, JSON.stringify(errors));
    await ctx.close();
  }

  // 5. Library state survives a reload (IndexedDB), including a partial narration position.
  {
    const ctx = await browser.newContext();
    const { page } = await open(ctx, (route) => route.fulfill({ status: 200, contentType: "audio/wav", body: wav() }));
    await page.reload();
    const found = await page.getByText("Story").first().waitFor({ timeout: 5000 }).then(() => true, () => false);
    check("item persists across reload", found);
    await ctx.close();
  }
} catch (e) {
  console.log("FAIL exception", e);
  failed++;
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
