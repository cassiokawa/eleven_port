import { build } from "esbuild";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const out = new URL("./dist/", import.meta.url).pathname;
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const common = { bundle: true, sourcemap: false, target: "chrome120", logLevel: "info", define: { "process.env.NODE_ENV": '"production"' } };
await build({ ...common, entryPoints: ["src/background.ts"], outfile: out + "background.js", format: "esm" });
await build({ ...common, entryPoints: ["src/content.ts"], outfile: out + "content.js", format: "iife" });
await build({ ...common, entryPoints: ["src/sidepanel.tsx"], outfile: out + "sidepanel.js", format: "esm", jsx: "automatic" });

// EP_TEST grants all-sites access so the E2E run can drive tabs without a user gesture.
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
if (process.env.EP_TEST) manifest.host_permissions = ["<all_urls>"];
writeFileSync(out + "manifest.json", JSON.stringify(manifest, null, 2));
cpSync("src/sidepanel.html", out + "sidepanel.html");

// OCR assets must be bundled locally: extension CSP blocks remote scripts and workers from blobs.
const ocr = out + "ocr/";
mkdirSync(ocr, { recursive: true });
const tessDist = dirname(require.resolve("tesseract.js/dist/worker.min.js"));
cpSync(join(tessDist, "worker.min.js"), ocr + "worker.min.js");
const core = dirname(require.resolve("tesseract.js-core/package.json"));
for (const f of readdirSync(core)) if (/^tesseract-core.*\.(js|wasm)$/.test(f)) cpSync(join(core, f), ocr + f);
const lang = dirname(require.resolve("@tesseract.js-data/eng/package.json")) + "/4.0.0_best_int/eng.traineddata.gz";
// langPath serves <lang>.traineddata.gz when gzip is true.
writeFileSync(ocr + "eng.traineddata.gz", readFileSync(lang));
console.log("extension built ->", out);
