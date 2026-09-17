# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What pdf-seal does

A browser-based PDF editor for preparing documents with signature form fields. Users upload a PDF, place and customize signature fields, and download or share the modified document. The app does **not** cryptographically sign PDFs — it inserts interactive form fields that downstream signing tools recognize.

Key features: upload/preview PDFs, place/move/resize/remove signature fields, edit field properties (name, required, read-only), edit PDF metadata (title, author), download modified PDFs, share documents via WebSocket + WebRTC with encrypted transfer, browse and diff local version history, and reusable local signature templates.

## Development commands

```bash
npm install             # Install dependencies
npm run dev             # Run locally via tsx (no build step)
npm run build           # Compile TypeScript to dist/ (tsc)
npm start               # Run the compiled server (node dist/server.js)
npm run build:demo-sample  # Regenerate the bundled Help-tour sample PDF + demo root CA
```

There is no linter configured. Unit tests (Vitest) live under `test/`, mirroring the `lib/` layout (e.g. `test/lib/PdfSignatureTool.test.ts`). Run the full suite with `npm test`; run a single file with `npx vitest run test/lib/PdfSignatureTool.test.ts` or filter by name with `npx vitest run -t "some test name"`. Verify changes with `npm run build` (type checking), `npm test`, and manual testing against `http://localhost:3000`; add focused tests only for critical logic if needed.

Coverage (`lib/**` only — `server.ts` has no HTTP-level tests) is measured with `npm run test:coverage` (vitest + `@vitest/coverage-v8`). Thresholds are enforced in `vitest.config.ts`: statements/lines/functions at 90%, branches at 75% (many remaining branches are `??`/ternary fallbacks in formatting helpers not worth chasing individually). When adding logic to `lib/`, add or extend tests in the matching `test/lib/*.test.ts` file to keep coverage from regressing.

CI (`.github/workflows/ci.yml`) runs `npm run build` and `npm test` on every PR into `main`. Releases (`.github/workflows/release.yml`) run semantic-release on pushes to `main`, deriving the version bump and CHANGELOG from Conventional Commits (`feat:`, `fix:`, etc.) — don't hand-edit `package.json`'s version or `CHANGELOG.md`.

## Architecture

- **`server.ts`** — Express app serving the UI, handling multipart uploads (Multer), REST APIs for PDF operations, and WebSocket signaling for the share feature. All routes and rate limiting live here. The mutating PDF routes (`/api/edit-field`, `/api/remove-field`, `/api/apply-changes`, etc.) share one shape: `upload.single("pdfDocument")` → sanitize the path → `PdfSignatureTool.open()` → mutate → `tool.save()` to a new `modified_<timestamp>.pdf` → respond → clean up temp files in `UPLOADS_DIR`.
- **`lib/PdfSignatureTool.ts`** — Wraps pdf-lib to manage AcroForm signature fields and PDF metadata (open/edit/save a document).
- **`lib/PdfRevisionTool.ts`** — Compares PDF revisions at the raw-object level to detect changes (added/removed/modified signature fields, metadata changes); powers the Versions panel's compare view. `diffRawObjects()`/`describeRawObject()` contain the core diffing logic — rectangle (Rect) entries for annotations must be consolidated rather than reported as duplicate changes. Version history itself lives client-side in the browser's IndexedDB, not on the server or embedded in the PDF by default — the server only ever handles the current document unless a request explicitly asks to diff/embed snapshots.
- **`lib/SignatureTemplates.ts`** — pure logic for the Signatures panel's local signature templates (store normalization, capturing a placed field as a template item (`templateItemFromField`/`upsertTemplateItem`), field-name de-duplication, batch placement planning, moving an item between lists, and the JSON export/import format used by the backup buttons in Settings). Template items are never typed in by hand — they're captured from fields already placed on the document, so there is no numeric size/position editing anywhere in the UI. Like `lib/FieldHistory.ts`, this same logic is inlined in `public/index.html` (no frontend build step) and exists here for unit coverage — keep the two in sync by hand.
- **`lib/VersionHistory.ts`** — pure logic behind the Versions panel's timeline: classifying how each locally-stored save was produced (`classifySave` → `'initial' | 'identical' | 'incremental' | 'rewrite'`, based on whether the new bytes are the previous save's bytes with something appended), building the ordered badge list for one entry (`versionBadges` — Original/Imported, Incremental update/Full rewrite, Current, Signed, and an "earlier signatures may not verify" warning when a rewrite follows a signed entry), the "show only incremental updates" filter (`filterVersions`), and the labelled group breaks drawn between runs of like saves in the timeline (`versionGroupDividers` — one divider per change of save kind; `initial` groups with `rewrite`, while `identical` and legacy saveKind-less entries stay inside whatever run they sit in). A **version** here is any full save this browser has stored for the document (a fresh upload, an imported/embedded revision chain, or an edit) — most are full rewrites of the PDF, not PDF incremental updates; only saves that literally append to the previous file's bytes are badged "Incremental update". Like `SignatureTemplates.ts`/`FieldHistory.ts`, this logic is hand-mirrored inline in `public/index.html` (no frontend build step) — keep the two in sync by hand.
- **`lib/DemoTour.ts`** — pure logic behind the in-app Help tour: popover/spotlight geometry (`computePopoverPosition`, `spotlightRect`), step navigation (`findStepIndex`, `chapterStartIndex`), and settings-override merging (`mergeSettingsOverride`). Like `SignatureTemplates.ts`/`FieldHistory.ts`, this is hand-mirrored inline in `public/index.html` near the bottom of the main script (the tour engine, its 31-step/8-chapter script, and the settings/template sandboxing) — keep the two in sync by hand. The bundled sample document the tour runs against (`public/assets/demo/pdf-seal-sample.pdf`, plus `pdf-seal-demo-root-ca.pem` for the Certificates chapter's trust-simulation demo) is generated by `scripts/build-demo-sample.ts` (`npm run build:demo-sample`), which reuses `test/lib/helpers/certificateFactory.ts` and `test/lib/helpers/pdfSigner.ts` to mint a real certificate chain and produce a genuinely three-revision, signed PDF. `test/demoSample.test.ts` guards the committed sample against silent rot when field/metadata/revision-chain handling in `lib/PdfSignatureTool.ts` changes — regenerate the sample and re-run tests if it fails.
- **`public/index.html` + `public/styles.css`** — Single-page UI (document preview + control panel) as a large monolithic HTML/CSS pair (no build step, no framework). pdf.js is self-hosted under `public/vendor/`, not loaded from a CDN.
- **Sharing** — `/share/:sessionId` pages plus a `WebSocketServer` in `server.ts` handle signaling only; the actual PDF bytes move browser-to-browser over a WebRTC data channel in chunks with backpressure, verified by the recipient via SHA-256. Share sessions exist only in server memory (`socketSessions`/session maps in `server.ts`) and expire after 15 minutes — there is no persistence to design around.

## Key rules

- **Filesystem safety**: any request-derived path must be reduced to a bare filename with `path.basename()` and rejoined onto the fixed, trusted `UPLOADS_DIR` (`server.ts`) before touching `fs.*`. Inline this check next to the fs call itself — see the pattern around line 39 of `server.ts`.
- **Rate limiting**: every new HTTP route needs `generalLimiter`, plus `uploadLimiter` if it handles file uploads.
- **No CDN scripts**: self-host third-party libraries under `public/vendor/` instead of loading from external CDNs.
- **Proxy trust**: `app.set("trust proxy", 1)` is intentional for Railway's single proxy hop — don't change it without understanding the tradeoff.

## Working guidelines

- **PDF field operations**: start at `lib/PdfSignatureTool.ts`.
- **Version tracking**: changes to field detection or diff logic go in `lib/PdfRevisionTool.ts`; changes to how a save is classified or badged (Original/Imported, Incremental update/Full rewrite, Current, Signed) go in `lib/VersionHistory.ts`. A "version" is any full save stored locally (upload, imported chain entry, or edit) — only a save whose bytes are an exact byte-for-byte extension of the previous one counts as an "Incremental update"; everything else is a "Full rewrite", even if the PDF itself used a true incremental-update structure internally. Verify the Versions panel displays badges and changes correctly after edits.
- **File uploads**: keep cleanup correct in `server.ts`; follow the filesystem-safety rule above.
- **New routes**: add rate limiting and follow the security conventions above.
- **UI changes**: update `public/index.html` and `public/styles.css` together.
- **Sharing**: keep WebSocket signaling logic in `server.ts` and the browser-side WebRTC flow in sync. Share sessions exist only in server memory and expire after 15 minutes.
