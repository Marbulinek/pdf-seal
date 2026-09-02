# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What pdf-seal does

A browser-based PDF editor for preparing documents with signature form fields. Users upload a PDF, place and customize signature fields, and download or share the modified document. The app does **not** cryptographically sign PDFs — it inserts interactive form fields that downstream signing tools recognize.

Key features: upload/preview PDFs, place/move/resize/remove signature fields, edit field properties (name, required, read-only), edit PDF metadata (title, author), download modified PDFs, share documents via WebSocket + WebRTC with encrypted transfer, diff PDF revisions, and reusable local signature templates.

## Development commands

```bash
npm install     # Install dependencies
npm run dev     # Run locally via tsx (no build step)
npm run build   # Compile TypeScript to dist/ (tsc)
npm start       # Run the compiled server (node dist/server.js)
```

There is no linter configured. Unit tests (Vitest) live under `test/`, mirroring the `lib/` layout (e.g. `test/lib/PdfSignatureTool.test.ts`). Run the full suite with `npm test`; run a single file with `npx vitest run test/lib/PdfSignatureTool.test.ts` or filter by name with `npx vitest run -t "some test name"`. Verify changes with `npm run build` (type checking), `npm test`, and manual testing against `http://localhost:3000`; add focused tests only for critical logic if needed.

Coverage (`lib/**` only — `server.ts` has no HTTP-level tests) is measured with `npm run test:coverage` (vitest + `@vitest/coverage-v8`). Thresholds are enforced in `vitest.config.ts`: statements/lines/functions at 90%, branches at 75% (many remaining branches are `??`/ternary fallbacks in formatting helpers not worth chasing individually). When adding logic to `lib/`, add or extend tests in the matching `test/lib/*.test.ts` file to keep coverage from regressing.

CI (`.github/workflows/ci.yml`) runs `npm run build` and `npm test` on every PR into `main`. Releases (`.github/workflows/release.yml`) run semantic-release on pushes to `main`, deriving the version bump and CHANGELOG from Conventional Commits (`feat:`, `fix:`, etc.) — don't hand-edit `package.json`'s version or `CHANGELOG.md`.

## Architecture

- **`server.ts`** — Express app serving the UI, handling multipart uploads (Multer), REST APIs for PDF operations, and WebSocket signaling for the share feature. All routes and rate limiting live here. The mutating PDF routes (`/api/edit-field`, `/api/remove-field`, `/api/apply-changes`, etc.) share one shape: `upload.single("pdfDocument")` → sanitize the path → `PdfSignatureTool.open()` → mutate → `tool.save()` to a new `modified_<timestamp>.pdf` → respond → clean up temp files in `UPLOADS_DIR`.
- **`lib/PdfSignatureTool.ts`** — Wraps pdf-lib to manage AcroForm signature fields and PDF metadata (open/edit/save a document).
- **`lib/PdfRevisionTool.ts`** — Compares PDF revisions at the raw-object level to detect changes (added/removed/modified signature fields, metadata changes); powers the revision panel UI. `diffRawObjects()`/`describeRawObject()` contain the core diffing logic — rectangle (Rect) entries for annotations must be consolidated rather than reported as duplicate changes. Revision history itself lives client-side in the browser's IndexedDB, not on the server or embedded in the PDF by default — the server only ever handles the current document unless a request explicitly asks to diff/embed snapshots.
- **`lib/SignatureTemplates.ts`** — pure logic for the Signatures panel's local signature templates (store normalization, capturing a placed field as a template item (`templateItemFromField`/`upsertTemplateItem`), field-name de-duplication, batch placement planning, moving an item between lists, and the JSON export/import format used by the backup buttons in Settings). Template items are never typed in by hand — they're captured from fields already placed on the document, so there is no numeric size/position editing anywhere in the UI. Like `lib/FieldHistory.ts`, this same logic is inlined in `public/index.html` (no frontend build step) and exists here for unit coverage — keep the two in sync by hand.
- **`public/index.html` + `public/styles.css`** — Single-page UI (document preview + control panel) as a large monolithic HTML/CSS pair (no build step, no framework). pdf.js is self-hosted under `public/vendor/`, not loaded from a CDN.
- **Sharing** — `/share/:sessionId` pages plus a `WebSocketServer` in `server.ts` handle signaling only; the actual PDF bytes move browser-to-browser over a WebRTC data channel in chunks with backpressure, verified by the recipient via SHA-256. Share sessions exist only in server memory (`socketSessions`/session maps in `server.ts`) and expire after 15 minutes — there is no persistence to design around.

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
