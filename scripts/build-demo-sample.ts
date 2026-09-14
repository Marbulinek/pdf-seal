// Builds the bundled sample document used by the in-app Help tour.
//
// The output is a real, valid three-revision, one-signature PDF -- built by
// reusing the same certificate-minting and PDF-signing helpers the test
// suite uses to exercise the Certificates feature for real, rather than a
// checked-in binary blob nobody could regenerate or verify. Run this
// whenever lib/PdfSignatureTool.ts's field/metadata/revision-chain shape
// changes (test/demoSample.test.ts guards against silent rot).
//
// Usage: npm run build:demo-sample

import fs from 'fs';
import path from 'path';
import { StandardFonts, rgb } from 'pdf-lib';
import PdfSignatureTool from '../lib/PdfSignatureTool';
import { mint, type MintedCertificate } from '../test/lib/helpers/certificateFactory';
import { buildSignedPdfFixture } from '../test/lib/helpers/pdfSigner';

const OUT_DIR = path.join(__dirname, '..', 'public', 'assets', 'demo');
const TEN_YEARS_MS = 86400000 * 3650;

const AGREEMENT_TITLE = 'PDF Seal Sample Document';
const AGREEMENT_AUTHOR = 'PDF Seal Demo';
const AGREEMENT_SUBJECT = 'Sample document used by the pdf-seal interactive tour';
const AGREEMENT_KEYWORDS = ['demo', 'sample', 'pdf-seal'];

/** Draws the two-page sample document body, wrapping the turnaround clause. */
async function buildAgreementDocument(turnaroundDays: number): Promise<PdfSignatureTool> {
  const tool = await PdfSignatureTool.create();
  tool.addPage();
  tool.addPage();

  const doc = (tool as any).pdfDoc;
  const helvetica = await doc.embedFont(StandardFonts.Helvetica);
  const helveticaBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const pages = doc.getPages();

  const [page1, page2] = pages;
  const { width, height } = page1.getSize();
  const margin = 60;
  let y = height - margin;

  const drawLine = (page: any, text: string, options: { size?: number; bold?: boolean; gap?: number } = {}) => {
    const { size = 11, bold = false, gap = 20 } = options;
    page.drawText(text, {
      x: margin,
      y,
      size,
      font: bold ? helveticaBold : helvetica,
      color: rgb(0.1, 0.1, 0.12),
    });
    y -= gap;
  };

  drawLine(page1, 'PDF SEAL', { size: 20, bold: true, gap: 40 });
  drawLine(page1, 'This sample document ships with pdf-seal to power the in-app Help');
  drawLine(page1, 'tour. pdf-seal is a browser-based tool for preparing PDF documents');
  drawLine(page1, 'with signature form fields — upload a document, place and customize', { gap: 20 });
  drawLine(page1, 'fields, edit metadata, and share the result for signing, all without', { gap: 20 });
  drawLine(page1, 'leaving the browser.', { gap: 32 });

  drawLine(page1, '1. About This Sample', { bold: true, gap: 24 });
  drawLine(page1, 'This document has three real revisions: an initial draft, one with');
  drawLine(page1, 'signature fields added, and one with a completed signature — so the', { gap: 20 });
  drawLine(page1, 'Revisions panel has genuine history to walk through.', { gap: 32 });

  drawLine(page1, '2. Turnaround', { bold: true, gap: 24 });
  drawLine(page1, `Turnaround: ${turnaroundDays} days`, { size: 12, bold: true, gap: 20 });
  drawLine(page1, 'Reviewers are asked to return a signed copy within the period stated', { gap: 20 });
  drawLine(page1, 'above, measured from when the document is shared.', { gap: 32 });

  drawLine(page1, '3. Field Placement', { bold: true, gap: 24 });
  drawLine(page1, 'pdf-seal places signature, text, and date fields directly onto the');
  drawLine(page1, 'page at the coordinates chosen in the editor, shown below.');

  y = height - margin;
  drawLine(page2, '4. Sign-off', { bold: true, gap: 32 });
  drawLine(page2, 'Provider:', { size: 11, gap: 70 });
  drawLine(page2, 'Client:', { size: 11, gap: 70 });
  drawLine(page2, 'Client name:', { size: 11, gap: 40 });
  drawLine(page2, 'Date signed:', { size: 11, gap: 20 });

  return tool;
}

async function buildRevisionOne(): Promise<Uint8Array> {
  const tool = await buildAgreementDocument(30);
  tool.setMetadata({
    title: AGREEMENT_TITLE,
    author: AGREEMENT_AUTHOR,
    subject: AGREEMENT_SUBJECT,
    keywords: AGREEMENT_KEYWORDS,
  });
  return tool.toBytes();
}

async function buildRevisionTwo(): Promise<Uint8Array> {
  const tool = await buildAgreementDocument(14);
  tool.setMetadata({
    title: AGREEMENT_TITLE,
    author: AGREEMENT_AUTHOR,
    subject: AGREEMENT_SUBJECT,
    keywords: AGREEMENT_KEYWORDS,
  });

  // Aligned to sit on the same line as each label drawn above (see drawLine()
  // calls for "Provider:"/"Client:"/"Client name:"/"Date signed:" -- pages
  // default to A4 (height 841.89), so their baselines are 749.89/679.89/
  // 609.89/569.89 respectively), starting well past the longest label
  // ("Client name:"/"Date signed:") so nothing overlaps.
  tool.addSignatureField(1, 'Provider_Signature', {
    x: 180, y: 733, width: 220, height: 40, required: true,
  });
  tool.addSignatureField(1, 'Client_Signature', {
    x: 180, y: 663, width: 220, height: 40, required: true,
  });
  tool.addTextField(1, 'Client_Name', { x: 180, y: 602, width: 220, height: 22 });
  tool.addTextField(1, 'Signing_Date', { x: 180, y: 562, width: 220, height: 22 });

  return tool.toBytes();
}

async function mintDemoChain(): Promise<{ root: MintedCertificate; intermediate: MintedCertificate; leaf: MintedCertificate }> {
  const root = await mint({
    commonName: 'PDF Seal Demo Root CA',
    organization: 'PDF Seal Demo',
    country: 'US',
    isCa: true,
    pathLen: 2,
    notBeforeOffsetMs: -TEN_YEARS_MS / 2,
    notAfterOffsetMs: TEN_YEARS_MS,
  });
  const intermediate = await mint({
    commonName: 'PDF Seal Demo Signing CA',
    organization: 'PDF Seal Demo',
    isCa: true,
    pathLen: 0,
    issuer: root,
    notBeforeOffsetMs: -TEN_YEARS_MS / 2,
    notAfterOffsetMs: TEN_YEARS_MS,
  });
  const leaf = await mint({
    commonName: 'Alex Morgan',
    organization: 'PDF Seal Labs',
    issuer: intermediate,
    eku: ['1.3.6.1.5.5.7.3.36'],
    subjectAltNames: [{ type: 1, value: 'alex.morgan@example.invalid' }],
    notBeforeOffsetMs: -TEN_YEARS_MS / 2,
    notAfterOffsetMs: TEN_YEARS_MS,
  });
  return { root, intermediate, leaf };
}

async function buildRevisionThree(rev1: Uint8Array, rev2: Uint8Array, chain: { root: MintedCertificate; intermediate: MintedCertificate; leaf: MintedCertificate }): Promise<Uint8Array> {
  const tool = await PdfSignatureTool.fromBytes(rev2);
  const leanRev2 = await tool.toBytes();

  const entries = [
    { index: 1, bytes: Buffer.from(rev1).toString('base64') },
    { index: 2, bytes: Buffer.from(rev2).toString('base64') },
    { index: 3, bytes: Buffer.from(leanRev2).toString('base64') },
  ];
  tool.setRevisionSnapshotChain(entries);
  const chainedBytes = await tool.toBytes();

  const fixture = await buildSignedPdfFixture({
    basePdf: chainedBytes,
    fieldName: 'Provider_Signature',
    signer: chain.leaf,
    chain: [chain.leaf, chain.intermediate, chain.root],
    reason: 'I approve this service agreement',
    location: 'Remote',
    signerName: 'Alex Morgan',
  });

  return fixture.bytes;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const rev1 = await buildRevisionOne();
  const rev2 = await buildRevisionTwo();
  const chain = await mintDemoChain();
  const rev3 = await buildRevisionThree(rev1, rev2, chain);

  const pdfPath = path.join(OUT_DIR, 'pdf-seal-sample.pdf');
  fs.writeFileSync(pdfPath, rev3);
  console.log(`Wrote ${pdfPath} (${rev3.length} bytes)`);

  const pemPath = path.join(OUT_DIR, 'pdf-seal-demo-root-ca.pem');
  fs.writeFileSync(pemPath, chain.root.pem);
  console.log(`Wrote ${pemPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
