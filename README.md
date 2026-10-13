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

API environment: `ELEVENLABS_API_KEY` (narration), `ANTHROPIC_API_KEY` (optional refinement), `ANTHROPIC_MODEL` (default `claude-opus-5-5`), `API_TOKEN` (optional bearer auth), `ALLOWED_ORIGINS` (comma-separated browser origins; empty allows only same-origin/proxy use), `PORT`.

## Reliability model

- Every capture or import is a job whose units (pages, chunks) are saved as they finish. A crash, closed tab or dropout loses at most the unit in flight; reopening resumes where it stopped.
- One failed page never fails the book: it becomes a visible gap, and "Retry failed parts" re-runs only those.
- Network calls retry with backoff and jitter and wait while offline. Narration audio is cached on the device.
- Parts can be edited, re-processed, exported and narrated independently; the full library exports to a `.zip` and imports back.

## Tests

```bash
npm run typecheck && npm run lint && npm test
npm run e2e -w @eleven-port/web         # Chromium: retry, offline, audio cache, persistence
npm run e2e -w @eleven-port/extension   # Chromium with the extension loaded: page capture, screen OCR, book capture
```

## Known limits

- Kindle capture is verified against a mock paged reader only. The live Kindle Cloud Reader page-turn (synthetic ArrowRight key) and layout are untested; if the reader ignores synthetic keys, the loop stops after two unchanged pages and reports the position.
- The extension library and the web library are separate stores. Move items between them with the `.zip` export/import.
- Only English OCR data is bundled.
- The extension's side panel must stay open while a book is being captured.

See `docs/PRIVACY.md` for what data leaves your device.
