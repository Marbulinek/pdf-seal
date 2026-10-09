# pdf-seal-portal
PDF Seal portal

## What it finds

The extension works only on sites listed in **Settings → Allowed domains**. On any other site, the send button is disabled and the popup tells you which pattern to add. Nothing is injected into a page unless the tab's URL matches one of those patterns, and the check runs again right before every scan and export.

Clicking **Send via PDF Seal Portal** scans the tab and all of its frames. If it finds exactly one PDF, that PDF is sent right away. If it finds several, the popup lists them and you click the one to send.

Before anything is listed, each candidate is checked: its first bytes must be `%PDF-` (for URLs only the start of the file is downloaded). Broken links and non-PDF data are left out. Two kinds can't be checked in advance: cross-origin URLs and POST forms, which aren't submitted until you pick them. They're listed with a "Couldn't be checked in advance" note and are never sent automatically.

- **Viewers:** Nutrient/PSPDFKit (`exportPDF()`) and pdf.js (`saveDocument()`). Both include the form values and annotations made in the viewer. When the SDK is bundled into the app through npm (an Angular app, for example), there's no instance to export from. The PDF is then captured on its way into the viewer's worker, as the original document without annotations made in the viewer.
- **The tab or frame itself is a PDF.** Values typed into Chrome's built-in PDF viewer are not included, because Chrome exposes no API for them.
- **Embedded:** `<embed>`, `<object>` and `<iframe>` showing a PDF, with or without `type`. This covers `data:application/pdf;base64,…` and `blob:` URLs, plus viewer wrappers like `viewer.html?file=x.pdf`.
- **Links:** `<a href>` to a `.pdf`, a PDF `data:` URI, or a `blob:` link with `download`.
- **Base64:** bare `JVBERi0…` base64 in page text, inline scripts, form field values or attributes.
- **Script PDFs (whitelisted domains only):** PDFs that pass through `fetch`/XHR (raw, or base64 inside JSON) or `URL.createObjectURL`. Data that only ever lives in JS variables can't be reached.
- **Forms:** a `<form>` whose action or button mentions pdf/download/export/print/generate. Sending it re-submits the form, which only works same-origin or with CORS.

A PDF from another origin is fetched by the extension itself. The first time, Chrome asks for permission for that origin.

Test fixtures: `test/embeds.html` covers every case above and `test/fake-nutrient.html` covers Nutrient. Serve the repo root with `python3 -m http.server 8081`.

## Build

`npm run build:extension` (from the repo root) writes `dist/pdf-seal-extension.zip`, ready for the Chrome Web Store.

## Releases

The extension is versioned separately from the app, with `extension-v*` tags. A merge to `main` that touches `extension/` bumps `manifest.json`, uploads the zip to the Chrome Web Store and auto-publishes it. Use `feat(extension): …` / `fix(extension): …` commits.

Each release writes the new version into `manifest.json` (only the version line changes) and builds the zip. It then uploads and auto-publishes the zip to the Chrome Web Store, commits `manifest.json` and `CHANGELOG.md`, and attaches the zip to the GitHub release. Commits that don't touch `extension/` are ignored. The root app release ignores commits scoped `(extension)`, so unscoped `feat:`/`fix:` commits on extension-only changes would bump the app version too.

Branch builds: `.github/workflows/extension-ci.yml` builds the zip on pushes to any non-`main` branch that change `extension/**`. The zip is uploaded as a workflow artifact.

## One-time setup

1. Upload the first zip (`npm run build:extension`) by hand in the [Chrome Web Store developer dashboard](https://chrome.google.com/webstore/devconsole). This creates the item and gives you its extension ID.
2. Replace the `EXTENSION_ID` placeholder in the footer link in `public/index.html` (`https://chromewebstore.google.com/detail/EXTENSION_ID`) with the real ID.
3. Create a Google Cloud OAuth client, enable the Chrome Web Store API, and get a refresh token. See [chrome-webstore-upload-keys](https://github.com/fregante/chrome-webstore-upload-keys).
4. Add repo secrets: `CWS_EXTENSION_ID`, `CWS_PUBLISHER_ID` (shown on the developer dashboard's Account page), `CWS_CLIENT_ID`, `CWS_CLIENT_SECRET`, `CWS_REFRESH_TOKEN`.
5. Choose the starting version. With no `extension-v*` tag, the first automated release is `1.0.0`. To continue from the current `0.1.0`, push the tag `extension-v0.1.0` to `main` before the first merge.

`extension.pem` (the old crx signing key) is gitignored and no longer used. The Chrome Web Store signs uploads itself.
