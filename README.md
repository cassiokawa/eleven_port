# eleven_port

Capture what is on screen (web pages, PDFs, Markdown, Kindle Cloud Reader via OCR), assemble it into a structured Markdown book/article, manage it in a library, and narrate it with ElevenLabs.

Monorepo (npm workspaces):

- `packages/core`: document model, durable jobs, extractors, assembler, TTS, organize.
- `apps/extension`: Chrome MV3 extension.
- `apps/web`: library and reader web app.
- `apps/api`: ElevenLabs/URL proxy (key in `ELEVENLABS_API_KEY`).
