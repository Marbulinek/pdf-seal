# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What pdf-seal does

A browser-based PDF editor for preparing documents with signature form fields. Users upload a PDF, place and customize signature fields, and download or share the modified document. The app does **not** cryptographically sign PDFs — it inserts interactive form fields that downstream signing tools recognize.

Key features: upload/preview PDFs, place/move/resize/remove signature fields, edit field properties (name, required, read-only), edit PDF metadata (title, author), download modified PDFs, share documents via WebSocket + WebRTC with encrypted transfer, and diff PDF revisions.

## Development commands

```bash
npm install     # Install dependencies
npm run dev     # Run locally via ts-node (no build step)
npm run build   # Compile TypeScript to dist/ (tsc)
npm start       # Run the compiled server (node dist/server.js)
```

There is no linter configured. Unit tests (Vitest) live under `test/`, mirroring the `lib/` layout (e.g. `test/lib/PdfSignatureTool.test.ts`). Run them with `npm test`. Verify changes with `npm run build` (type checking), `npm test`, and manual testing against `http://localhost:3000`; add focused tests only for critical logic if needed.

## Architecture

- **`server.ts`** — Express app serving the UI, handling multipart uploads (Multer), REST APIs for PDF operations, and WebSocket signaling for the share feature. All routes and rate limiting live here.
- **`lib/PdfSignatureTool.ts`** — Wraps pdf-lib to manage AcroForm signature fields and PDF metadata (open/edit/save a document).
- **`lib/PdfRevisionTool.ts`** — Compares PDF revisions at the raw-object level to detect changes (added/removed/modified signature fields, metadata changes); powers the revision panel UI. `diffRawObjects()`/`describeRawObject()` contain the core diffing logic — rectangle (Rect) entries for annotations must be consolidated rather than reported as duplicate changes.
- **`public/index.html` + `public/styles.css`** — Single-page UI (document preview + control panel) as a large monolithic HTML/CSS pair (no build step, no framework). pdf.js is self-hosted under `public/vendor/`, not loaded from a CDN.

## Key rules

- **Filesystem safety**: any request-derived path must be reduced to a bare filename with `path.basename()` and rejoined onto the fixed, trusted `UPLOADS_DIR` (`server.ts`) before touching `fs.*`. Inline this check next to the fs call itself — see the pattern around line 39 of `server.ts`.
- **Rate limiting**: every new HTTP route needs `generalLimiter`, plus `uploadLimiter` if it handles file uploads.
- **No CDN scripts**: self-host third-party libraries under `public/vendor/` instead of loading from external CDNs.
- **Proxy trust**: `app.set("trust proxy", 1)` is intentional for Railway's single proxy hop — don't change it without understanding the tradeoff.

## Working guidelines

- **PDF field operations**: start at `lib/PdfSignatureTool.ts`.
- **Revision tracking**: changes to field detection or diff logic go in `lib/PdfRevisionTool.ts`; verify the revision panel displays changes correctly after edits.
- **File uploads**: keep cleanup correct in `server.ts`; follow the filesystem-safety rule above.
- **New routes**: add rate limiting and follow the security conventions above.
- **UI changes**: update `public/index.html` and `public/styles.css` together.
- **Sharing**: keep WebSocket signaling logic in `server.ts` and the browser-side WebRTC flow in sync. Share sessions exist only in server memory and expire after 15 minutes.
