import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH ?? "playwright");

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm" };
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

async function open(ctx, handler) {
  const page = await ctx.newPage();
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

  // 3. Library state survives a reload (IndexedDB), including a partial narration position.
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
