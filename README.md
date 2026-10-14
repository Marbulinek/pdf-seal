<img width="1648" height="954" alt="pdf-seal" src="https://github.com/user-attachments/assets/f5dd1848-342e-4afa-807d-3739a9cefa58" />

[![GitHub Release](https://img.shields.io/github/v/release/marbulinek/pdf-seal?include_prereleases)](https://github.com/marbulinek/pdf-seal/releases) [![Build Status](https://github.com/marbulinek/pdf-seal/actions/workflows/ci.yml/badge.svg)](https://github.com/marbulinek/pdf-seal/actions/workflows/ci.yml) ![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)

# PDF Seal

A browser-based editor for preparing PDFs for signing. Upload a PDF, place signature fields, then download it or share it with someone else.

**[Open the live app](https://pdf-seal-production.up.railway.app)**

> PDF Seal does **not** sign PDFs cryptographically. It adds signature form fields that PDF viewers and e-signing tools recognise, and it can inspect signatures that already exist.

## Tech stack

- **Frontend:** Angular 22 (standalone components, signals, zoneless), NgRx SignalStore, pdf.js
- **Backend:** Node.js, Express, TypeScript, pdf-lib
- **Tests:** Vitest
- **Storage:** none on the server — version history and templates live in your browser (IndexedDB)

## Sections

| Section | What it does |
| --- | --- |
| **Overview** | Read-only summary of the document: metadata (title, author…), fields, signatures, stamps, links and comments. |
| **Signatures** | Place, move, resize and remove signature fields, and save them as reusable templates. |
| **Versions** | Local history of every upload and edit. Compare any two versions and see what changed. |
| **Certificates** | Inspect the certificate chain of existing signatures and run an optional trust check. |

Also: **Share** sends the PDF directly to another browser (WebRTC), **?** opens help and an interactive tour, and a [browser extension](extension/README.md) can send PDFs from any page into the app.

## Project layout

```
app/        Angular UI
server/     Express API (+ its tests and scripts)
extension/  Chromium browser extension
```

All three share the single `package.json` at the root.

## Run, build, test

Requires **Node.js 24** (`nvm use` picks it up from `.nvmrc`; ^22.22.3 and 26+ also work).

```bash
npm install

npm run dev      # develop at http://localhost:3000 with live reload
npm run build    # build server + UI into dist/
npm start        # run the built app at http://localhost:3000
npm test         # unit tests (server + Angular); no running server needed
npm run test:e2e # end-to-end tests in Chromium (builds the app first)
```

The Angular unit tests run in jsdom with every server call mocked, so they work anywhere, CI included. The e2e tests (`e2e/`, Playwright) build and start the app themselves and drive it in a real browser; the first run also downloads Playwright's Chromium. On Linux, if Chromium then fails to launch, install its system libraries with `npx playwright install-deps chromium`.

Or with Docker:

```bash
docker compose up --build
```

More commands (coverage, demo sample, extension packaging) are listed in `package.json`; contributor notes are in [`AGENTS.md`](AGENTS.md).

## Privacy

Documents are processed in memory and deleted after each request. See [`PRIVACY_POLICY.md`](PRIVACY_POLICY.md).

## License

[MIT](LICENSE)
