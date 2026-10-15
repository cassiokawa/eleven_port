# eleven_port

Capture what is on screen (web pages, PDFs, Markdown, any visible screen, Kindle Cloud Reader via OCR), assemble it into structured Markdown, manage it in a library, and narrate it with ElevenLabs.

## Packages (npm workspaces)

| Path | Role |
|---|---|
| `packages/core` | Document model, resumable jobs, retry/backoff, extractors (web, PDF, OCR), page-capture engine, assembler, library, collections, tag/index suggestions, narration player |
| `apps/web` | Library and reader (Vite + React): import PDF/Markdown/URL/archive, edit parts, retry failed parts, narrate, export |
| `apps/extension` | Chrome MV3 side panel: capture page, read screen (OCR), capture a Kindle book, narrate |
| `apps/api` | Hono server: ElevenLabs proxy, SSRF-guarded page fetch, optional Claude-refined suggestions |

## Run it

```bash
npm install
cp .env.example .env   # fill in keys
npm run dev -w @eleven-port/api      # http://localhost:8787
npm run dev -w @eleven-port/web      # proxies /api to the server
npm run build -w @eleven-port/extension   # then load apps/extension/dist as an unpacked extension
```

API environment: see `.env.example`. `API_TOKEN` (optional bearer auth), `ALLOWED_ORIGINS` (comma-separated browser origins; empty allows only same-origin/proxy use), `PORT`.

## Cloud or local models

Each capability can run in the cloud or on your machine. The API picks the engine from its environment; the web app and extension show what is active under Settings.

| Capability | Cloud (default) | Local |
|---|---|---|
| Tag / collection suggestions | `LLM_PROVIDER=anthropic` + `ANTHROPIC_API_KEY` | `LLM_PROVIDER=ollama` + `OLLAMA_MODEL` (any chat model you have pulled; schema-constrained JSON, one retry, then the built-in heuristic suggestions stay) |
| Narration | `TTS_PROVIDER=elevenlabs` + `ELEVENLABS_API_KEY` | `TTS_PROVIDER=local` + `LOCAL_TTS_URL` pointing at an OpenAI-compatible `/v1/audio/speech` server such as Kokoro-FastAPI. **Ollama cannot generate speech**, so this is a separate server |
| OCR | Bundled Tesseract (always available, runs in the browser) | `OLLAMA_VISION_MODEL` + choose "Local vision model" in settings; any failure falls back to Tesseract per page |

### Fully local quick start (Ollama + Kokoro)

1. `ollama pull gemma4:12b` (confirm `ollama show gemma4:12b` lists `vision`).
2. Start [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI) (needs `espeak-ng`; on Apple Silicon use its native MPS start script). It serves `http://localhost:8880`.
3. `cp .env.local-models.example .env` and adjust the model and voice names.
4. `npm run doctor -w @eleven-port/api`. It checks Ollama, the models and their vision capability, the TTS server and voice, and synthesizes a test phrase. Fix every `FAIL` before starting the API.
5. `npm run dev -w @eleven-port/api`, then `GET /config` should report `ollama` and `local`.

Notes: local TTS ignores ElevenLabs-only options (voice stability/similarity and neighbouring-text context), so chunk joins can sound slightly less natural. Vision-model OCR is much slower than Tesseract, so capturing a whole book with it takes far longer; Tesseract stays the default. Small local models give weaker tags than Claude.

## Reliability model

- Every capture or import is a job whose units (pages, chunks) are saved as they finish. A crash, closed tab or dropout loses at most the unit in flight; reopening resumes where it stopped.
- One failed page never fails the book: it becomes a visible gap, and "Retry failed parts" re-runs only those.
- Network calls retry with backoff and jitter and wait while offline. Narration audio is cached on the device.
- **Every page turn is verified.** The capture engine waits for the screen to stop moving, compares a thumbnail of it with the previous page (no OCR needed when nothing changed), and only accepts the turn when the OCR text is a different page. A slow render gets progressively longer waits before the turn is declared failed, because turning again would skip a page. A failed turn falls back to the next method (Right Arrow, then a click on the right edge, then Page Down), two rounds in all. If nothing works it stops as "stalled" instead of claiming the book is done; it reports "done" only when the last page looks like an end-of-book screen. Pages that needed a retry are counted in the result.
- Parts can be edited, re-processed, exported and narrated independently; the full library exports to a `.zip` and imports back.

## Tests

```bash
npm run typecheck && npm run lint && npm test
npm run e2e -w @eleven-port/web         # Chromium: retry, offline, audio cache, persistence
npm run e2e -w @eleven-port/extension   # Chromium with the extension loaded: page capture, screen OCR, book capture
```

## Known limits

- Kindle capture is verified against mock paged readers only (including ones that ignore the keyboard or lock up). The live Kindle Cloud Reader layout and its response to synthetic key and click events are untested. Turn verification cannot detect a reader that advances two pages on one turn; if exported text jumps, lower the page-turn speed or report it.
- Chrome allows about two screenshots per second, so capturing a page takes at least a couple of seconds.
- The extension library and the web library are separate stores. Move items between them with the `.zip` export/import.
- Only English OCR data is bundled.
- The extension's side panel must stay open while a book is being captured.

See `docs/PRIVACY.md` for what data leaves your device.
