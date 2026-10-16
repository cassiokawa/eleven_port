// Runs the extension with its SHIPPED manifest (no all-sites grant), the way a fresh install behaves.
// The main E2E grants <all_urls> for convenience, which hid the real-world permission error.
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH ?? "playwright");

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const shipped = JSON.parse(readFileSync(fileURLToPath(new URL("../manifest.json", import.meta.url)), "utf8"));
const dir = mkdtempSync(join(tmpdir(), "ep-shipped-"));
cpSync(dist, dir, { recursive: true });
writeFileSync(join(dir, "manifest.json"), JSON.stringify(shipped));

const server = createServer((_, res) => res.setHeader("content-type", "text/html").end("<h1 style='font:40px sans-serif'>Some page</h1>")).listen(0);
const base = `http://localhost:${server.address().port}/`;
const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "ep-u-")), {
  executablePath: process.env.CHROMIUM_PATH,
  headless: false,
  args: ["--headless=new", `--disable-extensions-except=${dir}`, `--load-extension=${dir}`, "--no-sandbox"],
});
let failed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name} ${extra}`); if (!ok) failed++; };

try {
  let [sw] = ctx.serviceWorkers();
  sw ??= await ctx.waitForEvent("serviceworker", { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  check("shipped manifest has no all-sites grant", !JSON.stringify(shipped.host_permissions).includes("<all_urls>"));
  check("all-sites access is requestable", (shipped.optional_host_permissions ?? []).includes("<all_urls>"));

  const page = await ctx.newPage();
  await page.goto(base);
  // Without host access the tab URL is hidden, so find the tab as "the active one".
  const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ active: true }))[0]?.id);

  for (const [label, button] of [["book capture", "Capture book (Kindle)"], ["screen reading", "Read screen (OCR)"], ["page capture", "Capture page"]]) {
    const panel = await ctx.newPage();
    await panel.goto(`chrome-extension://${extId}/sidepanel.html?targetTab=${tabId}`);
    await panel.getByRole("button", { name: button }).click();
    const prompt = await panel.getByRole("button", { name: "Allow access to all sites" }).waitFor({ timeout: 20000 }).then(() => true, () => false);
    check(`${label}: shows the permission prompt instead of a raw error`, prompt);
    check(`${label}: no raw Chrome error text`, (await panel.getByText(/<all_urls>/).count()) === 0);
    check(`${label}: leaves no item behind`, (await panel.locator("li").count()) === 0);
    await panel.close();
  }
} catch (e) {
  console.log("FAIL exception", e);
  failed++;
} finally {
  await ctx.close();
  server.close();
}
process.exit(failed ? 1 : 0);
