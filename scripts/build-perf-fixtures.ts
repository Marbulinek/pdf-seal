// Builds the fixture PDFs used to measure and exercise the perf work on
// fix/performance-improvements: many fields, oversized images, a real
// classic-xref incremental-update chain, the app's own bundled revision
// chain format, an over-the-upload-limit file, and a corrupt file.
//
// Output goes to public/perf-fixtures/ (gitignored, dockerignored) so the
// dev server can serve it directly to the browser pane during manual
// testing, the same way public/assets/demo/ serves the tour sample.
//
// Usage: npm run build:perf-fixtures

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import PdfSignatureTool from '../lib/PdfSignatureTool';

const OUT_DIR = path.join(__dirname, '..', 'public', 'perf-fixtures');

// ---------------------------------------------------------------------
// Deterministic PRNG + PNG encoding, so every run produces byte-identical
// fixtures (no external image assets, nothing to keep in sync by hand).
// ---------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

/** A deterministic-noise, uncompressed-friendly (still real zlib) 8-bit RGB PNG. */
function noisePng(width: number, height: number, seed: number): Buffer {
  const rand = mulberry32(seed);
  const rowBytes = width * 3;
  const raw = Buffer.alloc((rowBytes + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (rowBytes + 1);
    raw[rowStart] = 0; // filter type: None
    for (let x = 0; x < rowBytes; x++) {
      raw[rowStart + 1 + x] = (rand() * 256) | 0;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const idat = zlib.deflateSync(raw, { level: 1 });

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------
// fields-60.pdf -- 30 pages, 60 fields, including invisible/required/read-only
// ---------------------------------------------------------------------

async function buildFieldsSixty(): Promise<Uint8Array> {
  const tool = await PdfSignatureTool.create();
  for (let i = 0; i < 30; i++) tool.addPage();

  for (let i = 0; i < 60; i++) {
    const page = i % 30;
    const required = i % 3 === 0;
    const readOnly = i % 5 === 0;
    const invisible = i % 7 === 0;
    const info = tool.addSignatureField(page, `Field_${i}`, {
      x: 40 + (i % 4) * 130,
      y: 40 + Math.floor((i % 12) / 4) * 90,
      width: 110,
      height: 40,
      required,
      readOnly,
    });
    if (invisible) {
      const doc = (tool as any).pdfDoc;
      const form = doc.getForm();
      const field = form.getFieldMaybe(info.name);
      if (field) {
        const dict = (field as any).acroField.dict;
        const flagsKey = doc.context.obj('F');
        dict.set(flagsKey, doc.context.obj(2)); // AnnotationFlags.Hidden
      }
    }
  }

  tool.setMetadata({
    title: 'Perf Fixture: 60 Fields',
    author: 'pdf-seal perf fixtures',
  });
  return tool.toBytes();
}

// ---------------------------------------------------------------------
// large-images-200-fields.pdf -- ~15MB via noise image streams + 200 fields
// ---------------------------------------------------------------------

async function buildLargeImages(): Promise<Uint8Array> {
  const tool = await PdfSignatureTool.create();
  const PAGE_COUNT = 20;
  for (let i = 0; i < PAGE_COUNT; i++) tool.addPage();

  const doc = (tool as any).pdfDoc;
  const pages = doc.getPages();

  // A small number of distinct noise images, each embedded exactly once
  // (so its stream data appears once) and then drawn -- at a tiny display
  // size -- across several pages, mirroring how a handful of oversized
  // source images end up displayed at 30-230px throughout a real document.
  const IMAGE_COUNT = 10;
  const IMAGE_SIZE = 700; // ~1.47MB raw RGB per image; noise barely deflates
  const embeddedImages: any[] = [];
  for (let i = 0; i < IMAGE_COUNT; i++) {
    const png = noisePng(IMAGE_SIZE, IMAGE_SIZE, i + 1);
    embeddedImages.push(await doc.embedPng(png));
  }

  for (let p = 0; p < PAGE_COUNT; p++) {
    const page = pages[p];
    const { height: ph } = page.getSize();
    for (let j = 0; j < 2; j++) {
      const embedded = embeddedImages[(p * 2 + j) % IMAGE_COUNT];
      const w = 150;
      const h = 150;
      page.drawImage(embedded, {
        x: 20 + j * (w + 10),
        y: ph - h - 20,
        width: w,
        height: h,
      });
    }
  }

  for (let i = 0; i < 200; i++) {
    tool.addSignatureField(i % PAGE_COUNT, `Field_${i}`, {
      x: 40 + (i % 5) * 100,
      y: 300 + Math.floor((i % 20) / 5) * 50,
      width: 90,
      height: 30,
    });
  }

  tool.setMetadata({
    title: 'Perf Fixture: Large Images + 200 Fields',
    author: 'pdf-seal perf fixtures',
  });
  return tool.toBytes();
}

// ---------------------------------------------------------------------
// native-incremental-6.pdf -- a real classic-xref incremental-update chain:
// a pdf-lib base save (useObjectStreams:false) plus 5 hand-written
// increments, each appending a new /Info object with its own
// xref/trailer/startxref/%%EOF, exactly as ISO 32000-1 7.5.6 describes.
// buildSignedPdfFixture() can't be reused here -- it rewrites the whole
// file on every call rather than appending to it.
// ---------------------------------------------------------------------

function appendClassicIncrement(bytes: Buffer, title: string): Buffer {
  const text = bytes.toString('latin1');

  const rootMatch = /\/Root\s+(\d+)\s+0\s+R/.exec(text);
  if (!rootMatch) throw new Error('fixture: no /Root reference found to carry forward');
  const rootRef = `${rootMatch[1]} 0 R`;

  const sizeMatches = [...text.matchAll(/\/Size\s+(\d+)/g)];
  if (!sizeMatches.length) throw new Error('fixture: no /Size found in any trailer');
  const prevSize = Math.max(...sizeMatches.map((m) => parseInt(m[1], 10)));

  const prevXrefMatch = [...text.matchAll(/startxref\s+(\d+)\s*%%EOF/g)].pop();
  if (!prevXrefMatch) throw new Error('fixture: no prior startxref/%%EOF to extend');
  const prevXrefOffset = parseInt(prevXrefMatch[1], 10);

  const infoObjNum = prevSize; // one past the previous highest object number
  const objOffset = bytes.length;
  const infoObj = `${infoObjNum} 0 obj\n<< /Title (${title}) /Producer (pdf-seal perf fixture) >>\nendobj\n`;
  const infoBuf = Buffer.from(infoObj, 'latin1');

  const xrefOffset = objOffset + infoBuf.length;
  const xrefEntry = `${String(objOffset).padStart(10, '0')} 00000 n \n`;
  if (xrefEntry.length !== 20) throw new Error('fixture: malformed xref entry width');

  const trailer =
    `xref\n${infoObjNum} 1\n${xrefEntry}` +
    `trailer\n<< /Size ${infoObjNum + 1} /Root ${rootRef} /Info ${infoObjNum} 0 R /Prev ${prevXrefOffset} >>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.concat([bytes, infoBuf, Buffer.from(trailer, 'latin1')]);
}

async function buildNativeIncrementalSix(): Promise<Uint8Array> {
  const tool = await PdfSignatureTool.create();
  tool.addPage();
  tool.addSignatureField(0, 'Signature1', { x: 50, y: 50, width: 200, height: 60 });
  tool.setMetadata({ title: 'Perf Fixture: Native Incremental Chain' });

  const pdfDoc = (tool as any).pdfDoc;
  let bytes = Buffer.from(await pdfDoc.save({ useObjectStreams: false }));

  for (let i = 1; i <= 5; i++) {
    bytes = appendClassicIncrement(bytes, `Increment ${i}`);
  }

  return bytes;
}

// ---------------------------------------------------------------------
// bundled-history-12.pdf -- the app's own PdfSealRevisionChainV1 format
// (setRevisionSnapshotChain), with 12 prior entries.
// ---------------------------------------------------------------------

async function buildBundledHistoryTwelve(): Promise<Uint8Array> {
  const priorBytesList: Uint8Array[] = [];
  for (let i = 1; i <= 12; i++) {
    const tool = await PdfSignatureTool.create();
    tool.addPage();
    for (let f = 0; f < i; f++) {
      tool.addSignatureField(0, `Field_${f}`, {
        x: 40 + (f % 5) * 100,
        y: 500 - Math.floor(f / 5) * 60,
        width: 90,
        height: 30,
      });
    }
    tool.setMetadata({ title: 'Perf Fixture: Bundled History', author: `Revision ${i}` });
    priorBytesList.push(await tool.toBytes());
  }

  const final = await PdfSignatureTool.create();
  final.addPage();
  for (let f = 0; f < 12; f++) {
    final.addSignatureField(0, `Field_${f}`, {
      x: 40 + (f % 5) * 100,
      y: 500 - Math.floor(f / 5) * 60,
      width: 90,
      height: 30,
    });
  }
  final.setMetadata({ title: 'Perf Fixture: Bundled History', author: 'Current' });

  const entries = priorBytesList.map((bytes, idx) => ({
    index: idx + 1,
    bytes: Buffer.from(bytes).toString('base64'),
  }));
  final.setRevisionSnapshotChain(entries);
  return final.toBytes();
}

// ---------------------------------------------------------------------
// oversize-26mb.pdf -- over MAX_UPLOAD_BYTES (25MB), so /api/info returns
// 413 after pdf.js has already rendered it client-side.
// ---------------------------------------------------------------------

async function buildOversize(): Promise<Uint8Array> {
  const tool = await PdfSignatureTool.create();
  const doc = (tool as any).pdfDoc;
  tool.addPage();
  const pages = doc.getPages();
  const target = pages[pages.length - 1];

  const TARGET_BYTES = 26 * 1024 * 1024;
  const IMAGE_SIZE = 800; // ~1.9MB raw per image before deflate

  const drawOne = async (seed: number) => {
    const png = noisePng(IMAGE_SIZE, IMAGE_SIZE, seed);
    const embedded = await doc.embedPng(png);
    target.drawImage(embedded, { x: 0, y: 0, width: 10, height: 10 });
  };

  // Calibrate against one real image instead of re-serializing the whole
  // (growing) document on every iteration, which would be O(n^2).
  const baseline = (await tool.toBytes()).length;
  await drawOne(1);
  const afterOne = (await tool.toBytes()).length;
  const perImage = afterOne - baseline;

  const remaining = TARGET_BYTES - afterOne;
  const additional = Math.max(0, Math.ceil(remaining / perImage));
  for (let i = 0; i < additional; i++) await drawOne(i + 2);

  return tool.toBytes();
}

// ---------------------------------------------------------------------
// corrupt.pdf -- looks like a PDF, isn't one.
// ---------------------------------------------------------------------

function buildCorrupt(): Buffer {
  const header = Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n', 'latin1');
  const junk = Buffer.alloc(2048);
  for (let i = 0; i < junk.length; i++) junk[i] = (i * 37 + 11) % 256;
  return Buffer.concat([header, junk]);
}

// ---------------------------------------------------------------------

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const write = (name: string, bytes: Uint8Array | Buffer) => {
    const filePath = path.join(OUT_DIR, name);
    fs.writeFileSync(filePath, bytes);
    const mb = (bytes.length / (1024 * 1024)).toFixed(2);
    console.log(`Wrote ${filePath} (${bytes.length} bytes, ${mb} MB)`);
  };

  write('fields-60.pdf', await buildFieldsSixty());
  write('large-images-200-fields.pdf', await buildLargeImages());
  write('native-incremental-6.pdf', await buildNativeIncrementalSix());
  write('bundled-history-12.pdf', await buildBundledHistoryTwelve());
  write('oversize-26mb.pdf', await buildOversize());
  write('corrupt.pdf', buildCorrupt());
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
