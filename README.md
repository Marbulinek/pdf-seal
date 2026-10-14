<img width="1648" height="954" alt="pdf-seal" src="https://github.com/user-attachments/assets/f5dd1848-342e-4afa-807d-3739a9cefa58" />

[![GitHub Release](https://img.shields.io/github/v/release/marbulinek/pdf-seal?include_prereleases)](https://github.com/marbulinek/pdf-seal/releases) [![Build Status](https://github.com/marbulinek/pdf-seal/actions/workflows/ci.yml/badge.svg)](https://github.com/marbulinek/pdf-seal/actions/workflows/ci.yml) ![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)

**PDF Seal** is a browser-based workspace for preparing PDFs for signing: place signature fields, inspect metadata, compare revisions, examine embedded certificates, and share the result peer-to-peer. Nothing is kept on a server — your document stays in your browser.

**[Open the live app](https://pdf-seal-production.up.railway.app)** · Built with Angular, Node.js, Express, TypeScript, pdf-lib and pdf.js.

> PDF Seal does **not** apply cryptographic signatures. It inserts interactive signature form fields that PDF viewers and e-signature tools recognise, and it can inspect signatures that already exist.

## Features

### Signature fields
- Upload a PDF, browse pages, and zoom the preview.
- Place a field by clicking **Place on Document** and then the page; drag to move, drag the corner handle to resize.
- Edit a field's name, position, size, required and read-only flags.
- Undo/redo field edits; changes are applied to the file in one step.
- Existing fields are shown as overlays directly on the document.

### Signature templates
- Capture placed fields into named, reusable lists kept in your browser.
- Drop a saved field onto any page, or place a whole list at its saved pages and positions in one batch.
- Back up and restore all templates as JSON from **Settings**.

### Metadata, stamps and raw objects
- Edit PDF metadata such as title and author.
- See stamps and annotations, and browse the underlying raw PDF objects with inline explanations.

### Version history and diffing
- Every upload, import and edit is stored as a local version (IndexedDB), with badges for *Original*, *Incremental update*, *Full rewrite*, *Current* and *Signed*, plus a warning when a rewrite could invalidate earlier signatures.
- Compare any two versions at the raw-object level: added, removed and modified fields, stamps, metadata and signatures, with a visual diff and jump-to-page.
- Understands both native incremental-update chains and this app's optional embedded revision bundle ("Include revisions when exporting / sharing" in Settings).

### Certificates
- Inspect the certificate chain of each signature: subject, issuer, validity, fingerprints.
- Run an opt-in **trust simulation** against a root bundle you supply — entirely client-side data, no trust store shipped, no network calls.
- Developer/tester tool to rewrite the certificates inside a signature (length-preserving byte patch that leaves every other signature intact).

### Sharing
- **Share** creates a `/share/:sessionId` link. The browsers connect over WebRTC and the PDF moves directly between them in chunks with backpressure, verified by SHA-256. The server only does signaling; sessions live in memory and expire after 15 minutes.

### Browser extension — PDF Seal Portal
A Chromium extension that sends a PDF from the page you're on (embedded viewers, links, generated PDFs, PDF-producing forms) straight into PDF Seal. It only acts on domains you allow in **Settings → Allowed domains**. See [`extension/README.md`](extension/README.md).

### Help & interactive tour
Click **?** next to Settings for per-feature docs, each with a "Show me" button. The interactive tour loads a bundled, genuinely signed three-revision "Service Agreement" and walks through fields, templates, metadata, versions and certificates. Regenerate the sample with `npm run build:demo-sample`.

## Run it locally

Requires Node.js ^22.22.3, ^24.15.0 or 26+ (the Angular CLI's minimum; `ng build`/`ng test` refuse to start on anything older, so `npm test` fails at `test:web`). `.nvmrc` pins Node 24, so `nvm use` picks it up.

```bash
npm install
npm run dev          # Angular build in watch mode + API under tsx watch
# or
npm run build && npm start
```

Then open <http://localhost:3000>. For hot module replacement, run `npm run dev:server` and `npm run dev:web` in two terminals and open <http://localhost:4200> instead (the Angular dev server proxies `/api` and `/signal` to the API).

### Docker

```bash
docker compose up --build
# or
docker build -t pdf-seal . && docker run -p 3000:3000 pdf-seal
```

The image is a multi-stage Node 24 / Alpine build shipping only production dependencies and the compiled `dist/` (the bundled API in `dist/server.js` and the Angular build in `dist/web/browser`).

## Development

| Command | Purpose |
| --- | --- |
| `npm run build` | Build the whole solution: `build:server` then `build:web` |
| `npm run build:server` | Type-check the server (`tsc`) and bundle it to `dist/server.js` (esbuild) |
| `npm run build:web` | Production build of the Angular UI to `dist/web/browser` |
| `npm start` | Run the built server on port 3000 (serves the built UI) |
| `npm run dev` | Angular build in watch mode + server under `tsx watch`, on port 3000 |
| `npm run dev:server` | Server only, under `tsx watch` (port 3000) |
| `npm run dev:web` | Angular dev server with HMR (port 4200, proxies `/api` and `/signal` to port 3000) |
| `npm test` | Both suites: `test:server` (Vitest, `test/` mirrors `lib/`) and `test:web` (Angular, `src/**/*.spec.ts`) |
| `npm run test:coverage` | Coverage with enforced thresholds on `lib/**`, plus Angular coverage |
| `npm run build:demo-sample` | Regenerate the Help-tour sample PDF and demo root CA |
| `npm run build:perf-fixtures` | Generate performance fixtures — see [`docs/performance.md`](docs/performance.md) |
| `npm run build:extension` | Zip the browser extension for the Chrome Web Store |

Releases are automated with semantic-release from Conventional Commits. Contributor and architecture notes live in [`AGENTS.md`](AGENTS.md).

## Tech stack

Angular 22 (standalone components, signals, zoneless, lazy routes) · NgRx SignalStore · Express · Multer · ws · pdf-lib · pkijs · pdf.js (self-hosted, no CDN) · TypeScript/tsx · IndexedDB · WebRTC · Vitest

## Privacy

Documents are processed in memory and cleaned up after each request; version history and templates stay in your browser. See [`PRIVACY_POLICY.md`](PRIVACY_POLICY.md).

## License

[MIT](LICENSE)
