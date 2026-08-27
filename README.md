<img width="1648" height="954" alt="pdf-seal" src="https://github.com/user-attachments/assets/f5dd1848-342e-4afa-807d-3739a9cefa58" />

pdf-seal is a browser-based PDF signature field editor built with Node.js, Express, TypeScript, and pdf-lib. It helps you upload a PDF, place signature fields directly on the document, adjust their size and position, and save the updated file.

[Live App](https://pdf-seal-production.up.railway.app)

## What the UI does

The app opens as a web workspace with two main areas:

- A document viewer on the left where you can preview the PDF, move between pages, and zoom in or out.
- A control panel on the right where you can add and edit signature fields.

### Available actions

1. Upload a PDF from the top header.
2. Browse pages and zoom the document preview.
3. View existing signature fields as overlays directly on the PDF.
4. Add a new signature field by clicking "Place on Document", then clicking anywhere on the page.
5. Drag a field to reposition it, or drag the green resize handle to change its size.
6. Edit a selected field's name, position, width, height, and whether it is required.
7. Edit PDF metadata such as title and author.
8. Save the modified PDF, or copy the document as Base64 for further processing.
9. Share it directly with another user via WebRTC connection.
10. Compare two revisions of a PDF to see what changed (added/removed/modified signature fields, metadata changes).

## How it works

pdf-seal does not apply a cryptographic signature. Instead, it prepares the PDF by adding empty signature form fields that PDF viewers and e-signature tools can recognize. These fields appear as interactive boxes in the document so a signer can later use them in a signing workflow.

## Direct PDF sharing

With a document open, select **Share** to create a `/share/:sessionId` link. When the recipient opens it, the two browsers establish a WebRTC data channel and the PDF is transferred in small binary chunks with backpressure. The recipient verifies the received bytes with SHA-256 before opening the file.
Share sessions exist only in server memory and expire after 15 minutes.

## Revision diffing

Open the revision panel to compare two versions of a PDF at the raw-object level. It reports added, removed, and modified signature fields as well as metadata changes between the two documents.

## Run the app

Install dependencies:

```bash
npm install
```

Run locally in development (via ts-node, no build step):

```bash
npm run dev
```

Or build and run the compiled server:

```bash
npm run build
npm start
```

Then open:

```text
http://localhost:3000
```

### Run with Docker

Build and run with Docker Compose:

```bash
docker compose up --build
```

Or plain Docker:

```bash
docker build -t pdf-seal .
docker run -p 3000:3000 pdf-seal
```

Then open the same `http://localhost:3000`. The image is a multi-stage build (Node 24, Alpine) that ships only production dependencies and the compiled `dist/` output.

## Tech stack

- Express for the web server
- Multer for PDF uploads
- pdf-lib for reading and editing PDF form fields
- TypeScript with ts-node for the app runtime

## Notes

This project is focused on editing signature fields in a PDF. It is useful for preparing documents for signing, but it does not perform the actual digital signing ceremony itself.
