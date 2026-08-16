# AGENTS.md

## Project purpose

pdf-seal is a browser-based PDF editor for preparing documents for signing workflows. It lets a user upload a PDF, place empty signature form fields on specific pages, adjust their size and position, edit field properties, and download the modified document.

This project does not create cryptographically signed PDFs. It prepares documents by inserting interactive signature form fields that downstream signing tools and PDF viewers can recognize.

## Architecture at a glance

- Server entry point: [server.ts](server.ts)
  - Creates an Express app and serves the browser UI from [public](public)
  - Handles multipart uploads with multer and temporary files in [uploads](uploads)
  - Exposes REST endpoints for PDF inspection and field editing:
    - POST /api/info
    - POST /api/add-signature
    - POST /api/edit-field
    - POST /api/remove-field
  - Implements the share flow with WebSocket-based signaling at /signal and share links under /share/:sessionId
  - Share sessions are kept in memory and expire after 15 minutes

- PDF manipulation layer: [lib/PdfSignatureTool.ts](lib/PdfSignatureTool.ts)
  - Wraps pdf-lib with convenience methods for editing AcroForm signature fields
  - Supports adding, listing, renaming, moving, resizing, removing, and marking fields as required/read-only
  - Also reads and writes PDF metadata such as title, author, page count, and Info dictionary entries
  - Uses a merged field+widget structure for signature fields rather than pdf-lib's split-field helpers

- Frontend UI: [public/index.html](public/index.html) and [public/styles.css](public/styles.css)
  - Single-page browser UI with a document preview and a controls pane
  - Lets the user upload a PDF, preview pages, place signature fields, edit their properties, and download or share the document
  - The frontend communicates with the server API rather than using a separate framework

## How the app works

1. The browser uploads a PDF to one of the server endpoints.
2. The server stores the uploaded file in [uploads](uploads), opens it with [lib/PdfSignatureTool.ts](lib/PdfSignatureTool.ts), and applies the requested change.
3. The server writes a modified PDF to disk and returns it as a download.
4. For sharing, the sender and receiver connect over WebSocket signaling; the sender uploads encrypted document bytes, and the receiver downloads the shared file through the relay flow.

## Important constraints

- Keep the scope focused on preparing signature fields for signing workflows.
- Do not add real cryptographic signing behavior unless the task explicitly requests it.
- Preserve the existing API contract unless a change truly requires it.
- Be careful with field names and rectangle coordinates; they directly affect how the PDF is interpreted by viewers and downstream signing tools.
- Avoid introducing a separate architecture or framework unless the task specifically calls for it.

## Development commands

Install dependencies:

```bash
npm install
```

Run locally in development mode:

```bash
npm run dev
```

Build the TypeScript project:

```bash
npm run build
```

Start the compiled server:

```bash
npm start
```

## Working conventions for agents

- If the task touches PDF field behavior, inspect and likely edit [lib/PdfSignatureTool.ts](lib/PdfSignatureTool.ts) first.
- If the task affects file uploads, downloads, or temporary file handling, inspect [server.ts](server.ts) and keep cleanup behavior correct.
- If the task changes the visible workflow or document controls, update [public/index.html](public/index.html) and [public/styles.css](public/styles.css) together.
- If the task affects sharing or real-time transfer, inspect the WebSocket share logic in [server.ts](server.ts) and keep the browser-side sharing flow in sync.
- Prefer small, focused changes and keep the UI and server behavior aligned.
- The project currently has no dedicated test suite. Verify changes with a build after editing code.

## Agent checklist

- Understand whether the task belongs to PDF editing, server routes, sharing, or the browser UI.
- Make the smallest change that addresses the root cause.
- Keep server and client logic consistent when behavior changes.
- Verify the result with `npm run build` before finishing.
