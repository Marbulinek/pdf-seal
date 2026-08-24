# AGENTS.md

## What pdf-seal does

A browser-based PDF editor for preparing documents with signature form fields. Users upload a PDF, place and customize signature fields, and download or share the modified document. The app does **not** cryptographically sign PDFs—it inserts interactive form fields that downstream signing tools recognize.

## Key features

- Upload and preview PDFs in the browser
- Place, move, resize, and remove signature form fields
- Edit field properties (name, required, read-only)
- Edit PDF metadata (title, author)
- Download modified PDFs
- Share documents with others via WebSocket and encrypted transfer

## Quick architecture

- **Server** (`server.ts`): Express app serving the UI, handling multipart uploads, REST APIs for PDF operations, and WebSocket signaling for sharing
- **PDF layer** (`lib/PdfSignatureTool.ts`): Wraps pdf-lib to manage AcroForm signature fields and metadata
- **Revision tracking** (`lib/PdfRevisionTool.ts`): Compares PDF revisions to detect changes (added/removed/modified signature fields, metadata changes); powers the revision panel UI
- **Frontend** (`public/index.html`, `public/styles.css`): Single-page UI with document preview and controls; pdf.js is self-hosted (not from CDN)

## Key rules

- **Filesystem safety**: Request-derived paths must be sanitized with `path.basename()` and rejoined onto `UPLOADS_DIR` before any `fs.*` call. Inline this check next to the fs call itself.
- **Rate limiting**: Every new HTTP route needs `generalLimiter` and `uploadLimiter` (if handling files).
- **No CDN scripts**: Self-host third-party libraries under `public/vendor/` instead of loading from external CDNs.
- **Proxy trust**: `app.set("trust proxy", 1)` is intentional for Railway's single proxy hop—don't change it without understanding the tradeoff.

## Development

```bash
npm install           # Install dependencies
npm run dev          # Run locally in dev mode
npm run build        # Build TypeScript
npm start            # Start compiled server
```

## Working guidelines

- **PDF fields**: Start at `lib/PdfSignatureTool.ts` for field operations.
- **Revision tracking**: Changes to field detection or diff logic go in `lib/PdfRevisionTool.ts`; verify revision panel displays changes correctly.
- **File uploads**: Keep cleanup correct in `server.ts`; follow filesystem-safety rules.
- **New routes**: Add rate limiting and follow security conventions.
- **UI changes**: Update `public/index.html` and `public/styles.css` together.
- **Sharing**: Keep WebSocket logic in `server.ts` and browser-side flow in sync.
- **Verification**: Run `npm run build` after changes; no test suite yet—test manually or add focused tests for critical changes.

## Tasks / TODO

### Fix rectangle handling in PDF revision comparisons

**Status:** Fixed  
**Priority:** High  
**Area:** PDF revision tracking  

**Issue:** When checking changes between PDF revisions, the revision comparison logic incorrectly handles rectangle (Rect) entries for signature fields. Multiple object references are treated as separate changes when they should be consolidated as a single rectangle update.

**Root cause:** `diffRawObjects()`/`describeRawObject()` in `lib/PdfRevisionTool.ts` computed a "Page" object's preview rectangle two different ways that could both fire for the same edit, causing duplicate rectangle entries to appear in the revision UI.

**Fix:** `describeRawObject()` now tracks independently-tracked keys and excludes annotation refs already accounted for from the Page-level rect fallback, preventing duplicates while preserving audit trail accuracy.
