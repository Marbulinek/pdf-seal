# AGENTS.md

## Project purpose

pdf-seal is a browser-based PDF editor for preparing documents for signing workflows. It lets a user upload a PDF, place empty signature form fields on specific pages, adjust their size and position, edit field properties, and download the modified document.

This project does not create cryptographically signed PDFs. It prepares documents by inserting interactive signature form fields that downstream signing tools and PDF viewers can recognize.

## Architecture at a glance

- Server entry point: [server.ts](https://github.com/Marbulinek/pdf-seal/blob/main/server.ts)
  - Creates an Express app and serves the browser UI from [public](https://github.com/Marbulinek/pdf-seal/blob/main/public)
  - Handles multipart uploads with multer and temporary files in [uploads](https://github.com/Marbulinek/pdf-seal/blob/main/uploads)
  - Exposes REST endpoints for PDF inspection and field editing:
    - POST /api/info
    - POST /api/add-signature
    - POST /api/edit-field
    - POST /api/remove-field
  - Implements the share flow with WebSocket-based signaling at /signal and share links under /share/:sessionId
  - Share sessions are kept in memory and expire after 15 minutes

- PDF manipulation layer: [lib/PdfSignatureTool.ts](https://github.com/Marbulinek/pdf-seal/blob/main/lib/PdfSignatureTool.ts)
  - Wraps pdf-lib with convenience methods for editing AcroForm signature fields
  - Supports adding, listing, renaming, moving, resizing, removing, and marking fields as required/read-only
  - Also reads and writes PDF metadata such as title, author, page count, and Info dictionary entries
  - Uses a merged field+widget structure for signature fields rather than pdf-lib's split-field helpers

- Frontend UI: [public/index.html](https://github.com/Marbulinek/pdf-seal/blob/main/public/index.html) and [public/styles.css](https://github.com/Marbulinek/pdf-seal/blob/main/public/styles.css)
  - Single-page browser UI with a document preview and a controls pane
  - Lets the user upload a PDF, preview pages, place signature fields, edit their properties, and download or share the document
  - The frontend communicates with the server API rather than using a separate framework
  - The PDF rendering library (pdf.js) is self-hosted under [public/vendor/pdfjs](https://github.com/Marbulinek/pdf-seal/blob/main/public/vendor/pdfjs), not loaded from a CDN -- see "Security conventions" below before changing this

## How the app works

1. The browser uploads a PDF to one of the server endpoints.
2. The server stores the uploaded file in [uploads](https://github.com/Marbulinek/pdf-seal/blob/main/uploads), opens it with [lib/PdfSignatureTool.ts](https://github.com/Marbulinek/pdf-seal/blob/main/lib/PdfSignatureTool.ts), and applies the requested change.
3. The server writes a modified PDF to disk and returns it as a download.
4. For sharing, the sender and receiver connect over WebSocket signaling; the sender uploads encrypted document bytes, and the receiver downloads the shared file through the relay flow.

## Important constraints

- Keep the scope focused on preparing signature fields for signing workflows.
- Do not add real cryptographic signing behavior unless the task explicitly requests it.
- Preserve the existing API contract unless a change truly requires it.
- Be careful with field names and rectangle coordinates; they directly affect how the PDF is interpreted by viewers and downstream signing tools.
- Avoid introducing a separate architecture or framework unless the task specifically calls for it.

## Security conventions

These patterns exist because of specific vulnerabilities found by CodeQL and fixed in past PRs. Re-introducing the old pattern will very likely reintroduce the same alert -- follow these whenever a task touches the relevant area.

- **Filesystem paths derived from a request must never be used as-is.** Any path that traces back to `req` (an uploaded file's path, a filename in a form field, etc.) must be reduced with `path.basename()` and rejoined onto a fixed, trusted directory constant (e.g. `UPLOADS_DIR` in `server.ts`) before it's passed to any `fs.*` call. Do this inline, next to the `fs` call itself -- routing it through a separate helper function can prevent CodeQL's dataflow analysis from recognizing the sanitization. Never rely on `path.resolve()` + a `startsWith()`/`path.relative()` check alone; it's runtime-correct but CodeQL doesn't reliably recognize it as a sanitizer.
- **Every new HTTP route needs rate limiting.** Apply the existing `generalLimiter` (applied globally) and, for any route that parses/writes files, also add `uploadLimiter` as route middleware, matching the pattern already used on `/api/add-signature`, `/api/edit-field`, `/api/remove-field`, and `/api/info`.
- **Don't load third-party scripts from a CDN in `public/index.html`.** pdf.js is deliberately vendored under `public/vendor/pdfjs/` (pulled from the official `pdfjs-dist` npm package) instead of `cdnjs.cloudflare.com`, to avoid an "inclusion of functionality from an untrusted source" alert. If a task needs a new client-side library, prefer bundling/self-hosting it the same way rather than adding a `<script src="https://...">` tag.
- **`app.set("trust proxy", 1)` is deliberate, not a default.** It tells Express to trust exactly one reverse-proxy hop (Railway's edge), which is required for `express-rate-limit` to key on the real client IP instead of erroring or trusting a spoofable header. Do not change this to `true` (trusts every hop, letting a client forge its own IP to dodge rate limiting) without understanding the tradeoff. If the app is ever deployed behind an additional proxy/CDN layer, this number needs to increase to match.

## Environment variables

- `PORT` -- port the server listens on (Railway sets this automatically).
- `WEBRTC_STUN_URLS` -- comma-separated STUN server URLs handed to the client for the share flow. Optional; falls back to a public Google STUN server if unset.
- `WEBRTC_TURN_URLS` -- comma-separated TURN server URLs, for share connections behind restrictive NATs/firewalls. Optional.
- `WEBRTC_TURN_USERNAME` / `WEBRTC_TURN_CREDENTIAL` -- required together if `WEBRTC_TURN_URLS` is set; TURN config is silently dropped (with a logged error) if only one of the two is present.

## Development commands

Install dependencies:

```
npm install
```

Run locally in development mode:

```
npm run dev
```

Build the TypeScript project:

```
npm run build
```

Start the compiled server:

```
npm start
```

## Working conventions for agents

- If the task touches PDF field behavior, inspect and likely edit [lib/PdfSignatureTool.ts](https://github.com/Marbulinek/pdf-seal/blob/main/lib/PdfSignatureTool.ts) first.
- If the task affects file uploads, downloads, or temporary file handling, inspect [server.ts](https://github.com/Marbulinek/pdf-seal/blob/main/server.ts), keep cleanup behavior correct, and follow the filesystem-path rule in "Security conventions" above.
- If the task adds a new HTTP route, apply rate-limiting middleware per "Security conventions" above.
- If the task changes the visible workflow or document controls, update [public/index.html](https://github.com/Marbulinek/pdf-seal/blob/main/public/index.html) and [public/styles.css](https://github.com/Marbulinek/pdf-seal/blob/main/public/styles.css) together.
- If the task affects sharing or real-time transfer, inspect the WebSocket share logic in [server.ts](https://github.com/Marbulinek/pdf-seal/blob/main/server.ts) and keep the browser-side sharing flow in sync.
- Prefer small, focused changes and keep the UI and server behavior aligned.
- The project currently has no dedicated test suite. Verify changes with a build after editing code. If a change is security- or correctness-critical, adding a focused test alongside it is welcome even though none exist yet.

## Agent checklist

- Understand whether the task belongs to PDF editing, server routes, sharing, or the browser UI.
- Make the smallest change that addresses the root cause.
- Keep server and client logic consistent when behavior changes.
- If the change touches request-derived filesystem paths or adds an HTTP route, apply the relevant rule from "Security conventions."
- Verify the result with `npm run build` before finishing.

## Tasks / TODO

### Fix rectangle handling in PDF revision comparisons

**Status:** Fixed  
**Priority:** High  
**Area:** PDF revision tracking  
**Related files:** [lib/PdfRevisionTool.ts](https://github.com/Marbulinek/pdf-seal/blob/main/lib/PdfRevisionTool.ts) (the actual fix landed here, not PdfSignatureTool.ts -- see root cause below)

**Issue:**
When checking changes between PDF revisions, the revision comparison logic incorrectly handles rectangle (Rect) entries for signature fields. Multiple object references (e.g., `6 0 R`, `7 0 R`) are treated as separate changes when they should be consolidated as a single rectangle update.

**Root cause (confirmed via a standalone repro against the compiled lib/):**
`diffRawObjects()`/`describeRawObject()` in `lib/PdfRevisionTool.ts` computed a "Page" object's preview rectangle two different ways that could both fire for the same edit: (1) the page's own `/Annots` array gaining a ref is used to derive a rect from that annotation's `/Rect`, and (2) that same annotation object is *also* independently listed (and rendered) as its own added/modified object with its own `/Rect`. Adding or moving a signature field therefore surfaced the identical rectangle under two unrelated-looking entries (the "Page N" chip and the widget's own chip, e.g. `6 0 R` and `7 0 R`), which the revision UI drew/reported as two separate changes instead of one.

**Details:**
- PDF object references like `6 0 R` and `7 0 R` both represent rectangles within the document
- Current implementation may be registering duplicate or overlapping changes for the same rectangle modification
- This causes false positives when tracking which fields have actually changed between revisions
- Affects the accuracy of revision comparison and audit trails

**Expected behavior:**
- Revisions should correctly identify and group related rectangle changes
- A single field rectangle edit should be tracked as one logical change, not multiple independent object modifications
- Revision comparison should accurately reflect which signature fields were added, removed, moved, or resized

**Fix:**
`describeRawObject()` now takes the set of keys already independently tracked in the diff (`independentlyTrackedKeys`, built in `diffRawObjects()` from `addedKeys`/`modifiedKeys`/`removedKeys`) and excludes any annotation ref already in that set from the Page-level rect fallback. The Page object can still show up as changed (its `/Annots` dict diff is untouched), but it no longer re-derives/re-draws a rectangle that the annotation's own entry already covers. Verified end-to-end against the compiled `dist/lib` output: adding a signature field now reports its rectangle exactly once (under the field's own entry), where it previously also appeared under the page's entry.

**Acceptance criteria:**
- [x] Revision comparison correctly consolidates multiple object references into single logical changes
- [x] Rectangle modifications are properly deduplicated in revision diffs
- [x] Audit trail accurately reflects field modifications between revisions (the Page entry's dictionary diff still shows the `/Annots` change; only the redundant rectangle draw was removed, nothing was hidden)