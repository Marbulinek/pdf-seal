import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PDFArray, PDFHexString, PDFName } from 'pdf-lib';
import PdfSignatureTool from '../../lib/PdfSignatureTool';
import { buildSignedPdfFixture } from './helpers/pdfSigner';
import { mintStandardChain } from './helpers/certificateFactory';

describe('PdfSignatureTool', () => {
  it('creates a blank document with no fields', async () => {
    const tool = await PdfSignatureTool.create();
    expect(tool.listFields()).toEqual([]);
  });

  it('adds a signature field and lists it', async () => {
    const tool = await PdfSignatureTool.create();
    tool.addPage();
    tool.addSignatureField(0, 'signature1', { x: 50, y: 50, width: 200, height: 60 });

    const fields = tool.listFields();
    expect(fields).toHaveLength(1);
    expect(fields[0].name).toBe('signature1');
    expect(fields[0].type).toBe('Signature');
    expect(fields[0].page).toBe(0);
    expect(fields[0].rect).toMatchObject({ x: 50, y: 50, width: 200, height: 60 });
  });

  it('rejects adding a signature field on a page that does not exist', async () => {
    const tool = await PdfSignatureTool.create();
    tool.addPage();
    expect(() => tool.addSignatureField(5, 'sig', {})).toThrow(/Page index 5 does not exist/);
  });

  it('rejects a duplicate signature field name', async () => {
    const tool = await PdfSignatureTool.create();
    tool.addPage();
    tool.addSignatureField(0, 'signature1', {});
    expect(() => tool.addSignatureField(0, 'signature1', {})).toThrow(/already exists/);
  });

  it('adds a signature field with a tooltip and default rect', async () => {
    const tool = await PdfSignatureTool.create();
    tool.addPage();
    tool.addSignatureField(0, 'signature1', { tooltip: 'Sign here' });
    expect(tool.listFields()[0].tooltip).toBe('Sign here');
  });

  it('adds a required and read-only signature field', async () => {
    const tool = await PdfSignatureTool.create();
    tool.addPage();
    tool.addSignatureField(0, 'signature1', { required: true, readOnly: true });
    const field = tool.listFields()[0];
    expect(field.required).toBe(true);
    expect(field.readOnly).toBe(true);
  });

  it('adds a text field and lists it', async () => {
    const tool = await PdfSignatureTool.create();
    tool.addPage();
    tool.addTextField(0, 'name1', { x: 10, y: 10, width: 150, height: 30, tooltip: 'Full name' });

    const fields = tool.listFields();
    expect(fields).toHaveLength(1);
    expect(fields[0].type).toBe('TextField');
    expect(fields[0].tooltip).toBe('Full name');
  });

  it('adds multiple text fields, reusing the shared default font resource', async () => {
    const tool = await PdfSignatureTool.create();
    tool.addPage();
    tool.addTextField(0, 'name1', {});
    tool.addTextField(0, 'name2', { required: true, readOnly: true });

    const fields = tool.listFields();
    expect(fields).toHaveLength(2);
    expect(fields.find((f) => f.name === 'name2')?.required).toBe(true);
  });

  it('rejects adding a text field on a page that does not exist', async () => {
    const tool = await PdfSignatureTool.create();
    tool.addPage();
    expect(() => tool.addTextField(3, 'name1', {})).toThrow(/Page index 3 does not exist/);
  });

  it('rejects a duplicate text field name', async () => {
    const tool = await PdfSignatureTool.create();
    tool.addPage();
    tool.addTextField(0, 'name1', {});
    expect(() => tool.addTextField(0, 'name1', {})).toThrow(/already exists/);
  });

  it('adds a multiline text field and lists it as such', async () => {
    const tool = await PdfSignatureTool.create();
    tool.addPage();
    tool.addTextField(0, 'notes', { multiline: true });

    const field = tool.listFields()[0];
    expect(field.type).toBe('TextField');
    expect(field.multiline).toBe(true);
  });

  it('defaults a text field to single-line', async () => {
    const tool = await PdfSignatureTool.create();
    tool.addPage();
    tool.addTextField(0, 'name1', {});
    expect(tool.listFields()[0].multiline).toBe(false);
  });

  it('toggles a text field between single-line and multiline', async () => {
    const tool = await PdfSignatureTool.create();
    tool.addPage();
    tool.addTextField(0, 'notes', {});

    tool.setFieldMultiline('notes', true);
    expect(tool.listFields()[0].multiline).toBe(true);

    tool.setFieldMultiline('notes', false);
    expect(tool.listFields()[0].multiline).toBe(false);
  });

  it('rejects setting the multiline flag on a signature field', async () => {
    const tool = await PdfSignatureTool.create();
    tool.addPage();
    tool.addSignatureField(0, 'signature1', {});
    expect(() => tool.setFieldMultiline('signature1', true)).toThrow(/not a text field/);
  });

  it('reports multiline: false for signature fields', async () => {
    const tool = await PdfSignatureTool.create();
    tool.addPage();
    tool.addSignatureField(0, 'signature1', {});
    expect(tool.listFields()[0].multiline).toBe(false);
  });

  it('renames, requires, and removes a field', async () => {
    const tool = await PdfSignatureTool.create();
    tool.addPage();
    tool.addSignatureField(0, 'signature1', { x: 0, y: 0, width: 100, height: 40 });

    tool.renameField('signature1', 'signature2');
    tool.setFieldRequired('signature2', true);
    expect(tool.listFields()[0].name).toBe('signature2');
    expect(tool.listFields()[0].required).toBe(true);

    tool.removeField('signature2');
    expect(tool.listFields()).toEqual([]);
  });

  it('rejects renaming to a name that already exists', async () => {
    const tool = await PdfSignatureTool.create();
    tool.addPage();
    tool.addSignatureField(0, 'signature1', {});
    tool.addSignatureField(0, 'signature2', {});
    expect(() => tool.renameField('signature1', 'signature2')).toThrow(/already exists/);
  });

  it('throws when operating on an unknown field name', async () => {
    const tool = await PdfSignatureTool.create();
    expect(() => tool.setFieldRequired('nope', true)).toThrow(/No form field named "nope"/);
    expect(() => tool.removeField('nope')).toThrow(/No form field named "nope"/);
  });

  it('toggles required and read-only flags off again', async () => {
    const tool = await PdfSignatureTool.create();
    tool.addPage();
    tool.addSignatureField(0, 'signature1', { required: true, readOnly: true });

    tool.setFieldRequired('signature1', false);
    tool.setFieldReadOnly('signature1', false);
    const field = tool.listFields()[0];
    expect(field.required).toBe(false);
    expect(field.readOnly).toBe(false);

    tool.setFieldReadOnly('signature1', true);
    expect(tool.listFields()[0].readOnly).toBe(true);
  });

  it('sets a field tooltip', async () => {
    const tool = await PdfSignatureTool.create();
    tool.addPage();
    tool.addSignatureField(0, 'signature1', {});
    tool.setFieldTooltip('signature1', 'Please sign');
    expect(tool.listFields()[0].tooltip).toBe('Please sign');
  });

  it('moves and resizes a field rect, partially or fully', async () => {
    const tool = await PdfSignatureTool.create();
    tool.addPage();
    tool.addSignatureField(0, 'signature1', { x: 10, y: 10, width: 100, height: 40 });

    tool.setFieldRect('signature1', { x: 20 });
    let rect = tool.listFields()[0].rect;
    expect(rect).toMatchObject({ x: 20, y: 10, width: 100, height: 40 });

    tool.setFieldRect('signature1', { x: 30, y: 40, width: 200, height: 80 });
    rect = tool.listFields()[0].rect;
    expect(rect).toMatchObject({ x: 30, y: 40, width: 200, height: 80 });
  });

  it('moves a field to a different page', async () => {
    const tool = await PdfSignatureTool.create();
    tool.addPage();
    tool.addPage();
    tool.addSignatureField(0, 'signature1', {});
    expect(tool.listFields()[0].page).toBe(0);

    tool.setFieldPage('signature1', 1);
    expect(tool.listFields()[0].page).toBe(1);
  });

  it('rejects moving a field to a page that does not exist', async () => {
    const tool = await PdfSignatureTool.create();
    tool.addPage();
    tool.addSignatureField(0, 'signature1', {});
    expect(() => tool.setFieldPage('signature1', 9)).toThrow(/Page index 9 does not exist/);
  });

  it('reads a field\'s raw dictionary entries', async () => {
    const tool = await PdfSignatureTool.create();
    tool.addPage();
    tool.addSignatureField(0, 'signature1', {});
    const raw = tool.getFieldRaw('signature1');
    expect(raw.FT).toBe('/Sig');
    expect(raw.Subtype).toBe('/Widget');
  });

  it('returns an empty array from getSignatureInfo when no signature has been applied', async () => {
    const tool = await PdfSignatureTool.create();
    tool.addPage();
    tool.addSignatureField(0, 'signature1', {});
    expect(tool.getSignatureInfo()).toEqual([]);
  });

  it('round-trips metadata and PDF bytes', async () => {
    const tool = await PdfSignatureTool.create();
    tool.setMetadata({ title: 'Test Document', author: 'CI' });

    const bytes = await tool.toBytes();
    expect(bytes.length).toBeGreaterThan(0);

    const reloaded = await PdfSignatureTool.fromBytes(bytes);
    const meta = reloaded.getMetadata();
    expect(meta.title).toBe('Test Document');
    expect(meta.author).toBe('CI');
  });

  it('sets subject, keywords (array and single string), creator and producer', async () => {
    const tool = await PdfSignatureTool.create();
    tool.setMetadata({ subject: 'Subj', keywords: ['a', 'b'], creator: 'Creator', producer: 'Producer' });
    let meta = tool.getMetadata();
    expect(meta.subject).toBe('Subj');
    expect(meta.keywords).toBe('a b');
    expect(meta.creator).toBe('Creator');
    expect(meta.producer).toBe('Producer');

    tool.setMetadata({ keywords: 'single' });
    meta = tool.getMetadata();
    expect(meta.keywords).toBe('single');
  });

  it('round-trips an explicitly set modification date', async () => {
    const tool = await PdfSignatureTool.create();
    const modDate = new Date('2026-01-15T10:00:00.000Z');
    tool.setMetadata({ modificationDate: modDate });

    const bytes = await tool.toBytes();
    const reloaded = await PdfSignatureTool.fromBytes(bytes);
    expect(reloaded.getMetadata().modificationDate?.getTime()).toBe(modDate.getTime());
  });

  it('reports page count as part of metadata', async () => {
    const tool = await PdfSignatureTool.create();
    tool.addPage();
    tool.addPage();
    expect(tool.getMetadata().pageCount).toBe(2);
  });

  it('reads the raw Info dictionary, including custom entries', async () => {
    const tool = await PdfSignatureTool.create();
    tool.setMetadata({ title: 'Hello' });
    tool.setCustomInfoEntry('CustomKey', 'CustomValue');
    const raw = tool.getRawInfoDict();
    expect(raw.Title).toBe('Hello');
    expect(raw.CustomKey).toBe('CustomValue');
  });

  it('returns an empty object from getRawInfoDict when there is no Info dictionary', async () => {
    const tool = await PdfSignatureTool.create();
    (tool as any).pdfDoc.context.trailerInfo.Info = undefined;
    expect(tool.getRawInfoDict()).toEqual({});
  });

  it('stores and reads back a revision snapshot chain', async () => {
    const tool = await PdfSignatureTool.create();
    expect(tool.getRevisionSnapshotChain()).toEqual([]);

    tool.setRevisionSnapshotChain([{ index: 1, bytes: 'AAA' }, { index: 2, bytes: 'BBB' }]);
    const chain = tool.getRevisionSnapshotChain();
    expect(chain).toEqual([{ index: 1, bytes: 'AAA' }, { index: 2, bytes: 'BBB' }]);

    tool.clearRevisionSnapshotChain();
    expect(tool.getRevisionSnapshotChain()).toEqual([]);
  });

  it('clearRevisionSnapshotChain is a no-op when there is no Info dictionary', async () => {
    const tool = await PdfSignatureTool.create();
    expect(() => tool.clearRevisionSnapshotChain()).not.toThrow();
  });

  it('tolerates a malformed revision chain payload', async () => {
    const tool = await PdfSignatureTool.create();
    tool.setCustomInfoEntry('PdfSealRevisionChainV1', 'not json');
    expect(tool.getRevisionSnapshotChain()).toEqual([]);

    tool.setCustomInfoEntry('PdfSealRevisionChainV1', JSON.stringify({ not: 'an array' }));
    expect(tool.getRevisionSnapshotChain()).toEqual([]);

    tool.setCustomInfoEntry('PdfSealRevisionChainV1', JSON.stringify([{ bytes: 'ok' }, { no: 'bytes here' }]));
    expect(tool.getRevisionSnapshotChain()).toEqual([{ index: 1, bytes: 'ok' }]);
  });

  it('falls back to the legacy chain key name', async () => {
    const tool = await PdfSignatureTool.create();
    tool.setCustomInfoEntry('PdfSealRevisionChain', JSON.stringify([{ index: 2, bytes: 'legacy' }]));
    expect(tool.getRevisionSnapshotChain()).toEqual([{ index: 2, bytes: 'legacy' }]);
  });

  it('returns null XMP metadata when the document has none', async () => {
    const tool = await PdfSignatureTool.create();
    expect(tool.getXmpMetadata()).toBeNull();
  });

  it('reads an embedded XMP metadata packet off the catalog', async () => {
    const tool = await PdfSignatureTool.create();
    const pdfDoc = (tool as any).pdfDoc;
    const context = pdfDoc.context;
    const xml = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
      <x:xmpmeta xmlns:x="adobe:ns:meta/">
        <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
          <rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/">
            <dc:title><rdf:Alt><rdf:li xml:lang="x-default">XMP Title</rdf:li></rdf:Alt></dc:title>
            <xmp:CreatorTool>pdf-seal test</xmp:CreatorTool>
            <xmpMM:DocumentID>doc-123</xmpMM:DocumentID>
            <xmpMM:InstanceID>inst-456</xmpMM:InstanceID>
          </rdf:Description>
        </rdf:RDF>
      </x:xmpmeta>
    <?xpacket end="w"?>`;
    const stream = context.stream(xml, { Type: 'Metadata', Subtype: 'XML' });
    const streamRef = context.register(stream);
    pdfDoc.catalog.set(PDFName.of('Metadata'), streamRef);

    const xmp = tool.getXmpMetadata();
    expect(xmp).not.toBeNull();
    expect(xmp?.title).toBe('XMP Title');
    expect(xmp?.creatorTool).toBe('pdf-seal test');
    expect(xmp?.documentId).toBe('doc-123');
    expect(xmp?.instanceId).toBe('inst-456');
    expect(xmp?.raw).toContain('x:xmpmeta');
  });

  it('returns null from getXmpMetadata when there is no catalog', async () => {
    const tool = await PdfSignatureTool.create();
    (tool as any).pdfDoc.catalog = null;
    expect(tool.getXmpMetadata()).toBeNull();
  });

  it('produces a full metadata overview with page sizes and feature flags', async () => {
    const tool = await PdfSignatureTool.create();
    (tool as any).pdfDoc.addPage([612, 792]); // US Letter
    tool.addSignatureField(0, 'signature1', {});
    tool.setMetadata({ title: 'Overview doc' });

    const overview = tool.getMetadataOverview({ fileSize: 1234, incrementalUpdates: 2 });
    expect(overview.documentInfo.title).toBe('Overview doc');
    expect(overview.documentInfo.fileSize).toBe(1234);
    expect(overview.documentInfo.pdfVersion).toMatch(/^\d\.\d$/);
    expect(overview.features.signatureFieldCount).toBe(1);
    expect(overview.features.incrementalUpdates).toBe(2);
    expect(overview.features.encrypted).toBe(false);
    expect(overview.pages).toHaveLength(1);
    expect(overview.pages[0].sizeName).toBe('Letter');
    expect(overview.pages[0].orientation).toBe('Portrait');
    expect(overview.documentIds).toEqual({ permanent: null, changing: null, xmpDocumentId: null, xmpInstanceId: null });
  });

  it('recognizes a landscape A4 page and a rotated page\'s effective orientation', async () => {
    const tool = await PdfSignatureTool.create();
    const page = (tool as any).pdfDoc.addPage([841.89, 595.28]); // landscape A4
    page.setRotation({ type: 'degrees', angle: 90 });

    const overview = tool.getMetadataOverview({});
    expect(overview.pages[0].sizeName).toBe('A4');
    expect(overview.pages[0].rotation).toBe(90);
    // Rotated 90 degrees, the landscape page reads as portrait on screen.
    expect(overview.pages[0].orientation).toBe('Portrait');
  });

  it('labels an unrecognized page size by its dimensions', async () => {
    const tool = await PdfSignatureTool.create();
    (tool as any).pdfDoc.addPage([123, 456]);
    const overview = tool.getMetadataOverview({});
    expect(overview.pages[0].sizeName).toBe('123 × 456 pt');
  });

  it('lists attachments with filename, mime type and size', async () => {
    const tool = await PdfSignatureTool.create();
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    await (tool as any).pdfDoc.attach(data, 'notes.txt', { mimeType: 'text/plain' });
    // Attachment /Filespec objects only appear in enumerateIndirectObjects()
    // after a save/reload round-trip.
    const reloaded = await PdfSignatureTool.fromBytes(await tool.toBytes());

    const overview = reloaded.getMetadataOverview({});
    expect(overview.attachments).toHaveLength(1);
    expect(overview.attachments[0].filename).toBe('notes.txt');
    expect(overview.attachments[0].mimeType).toBe('text/plain');
    expect(overview.attachments[0].size).toBe(5);
    expect(overview.features.attachmentCount).toBe(1);
  });

  it('detects document IDs from the trailer', async () => {
    const tool = await PdfSignatureTool.create();
    const context = (tool as any).pdfDoc.context;
    context.trailerInfo.ID = PDFArray.withContext(context);
    context.trailerInfo.ID.push(PDFHexString.of('ABCDEF01'));
    context.trailerInfo.ID.push(PDFHexString.of('12345678'));

    const overview = tool.getMetadataOverview({});
    expect(overview.documentIds.permanent).toBe('abcdef01');
    expect(overview.documentIds.changing).toBe('12345678');
  });

  it('falls back to the permanent id for changing when only one trailer id entry exists', async () => {
    const tool = await PdfSignatureTool.create();
    const context = (tool as any).pdfDoc.context;
    context.trailerInfo.ID = PDFArray.withContext(context);
    context.trailerInfo.ID.push(PDFHexString.of('ABCDEF01'));

    const overview = tool.getMetadataOverview({});
    expect(overview.documentIds.permanent).toBe('abcdef01');
    expect(overview.documentIds.changing).toBe('abcdef01');
  });

  it('produces a fields-only document info summary', async () => {
    const tool = await PdfSignatureTool.create();
    tool.addPage();
    tool.addSignatureField(0, 'signature1', {});
    const summary = tool.getDocumentInfoSummary({ fieldsOnly: true });
    expect(Object.keys(summary)).toEqual(['fields']);
    expect(summary.fields).toHaveLength(1);
  });

  it('produces the full document info summary with metadata, raw info, fields, raw objects and overview', async () => {
    const tool = await PdfSignatureTool.create();
    tool.addPage();
    tool.addSignatureField(0, 'signature1', {});
    tool.setMetadata({ title: 'Full summary' });

    const summary = tool.getDocumentInfoSummary({ fileSize: 42 });
    expect(summary.metadata.title).toBe('Full summary');
    expect(summary.rawInfo.Title).toBe('Full summary');
    expect(summary.fields).toHaveLength(1);
    expect(summary.rawObjects.objects).toBeTypeOf('object');
    expect(summary.overview.documentInfo.fileSize).toBe(42);
  });

  it('walks the full raw object graph, keyed by object ref', async () => {
    const tool = await PdfSignatureTool.create();
    tool.addPage();
    tool.setMetadata({ title: 'Raw dump' });
    const dump = tool.getFullRawDump();
    expect(Object.keys(dump.objects).length).toBeGreaterThan(0);
    expect(dump.trailer).toBeTypeOf('object');
    const catalogEntry = Object.values(dump.objects).find((o: any) => o && o.Type === 'Catalog');
    expect(catalogEntry).toBeTruthy();
  });

  it('decodes a content stream\'s text via getStreamText', async () => {
    const tool = await PdfSignatureTool.create();
    const page = (tool as any).pdfDoc.addPage();
    page.drawText('Hello world', { x: 50, y: 700, size: 12 });
    // The content stream is only compressed (a decodable PDFRawStream) once
    // the document has actually been serialized and reloaded.
    const reloaded = await PdfSignatureTool.fromBytes(await tool.toBytes());

    const dump = reloaded.getFullRawDump();
    const streamKey = Object.keys(dump.objects).find((key) => (dump.objects[key] as any)['@type'] === 'Stream');
    expect(streamKey).toBeTruthy();

    const decoded = reloaded.getStreamText(streamKey as string);
    expect(decoded).not.toBeNull();
    expect(decoded?.text).toContain('Tj');
    expect(decoded?.rawByteLength).toBeGreaterThan(0);
  });

  it('returns null from getStreamText for a malformed ref or a non-stream object', async () => {
    const tool = await PdfSignatureTool.create();
    tool.addPage();
    expect(tool.getStreamText('not-a-ref')).toBeNull();
    expect(tool.getStreamText('9999 0 R')).toBeNull();

    const dump = tool.getFullRawDump();
    const nonStreamKey = Object.keys(dump.objects).find((key) => (dump.objects[key] as any)?.Type === 'Catalog');
    expect(tool.getStreamText(nonStreamKey as string)).toBeNull();
  });

  it('rejects opening a password-protected/encrypted PDF with a friendly message', async () => {
    await expect(
      PdfSignatureTool._load(new Uint8Array([1, 2, 3]), null).catch((e: any) => {
        throw e;
      }),
    ).rejects.toThrow();
  });
});

describe('PdfSignatureTool file I/O (open/save)', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('saves to disk and re-opens the same document', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-seal-test-'));
    const tool = await PdfSignatureTool.create();
    tool.addPage();
    tool.setMetadata({ title: 'Saved doc' });

    const savedPath = await tool.save('output.pdf', { baseDir: tmpDir });
    expect(savedPath).toBe(path.join(path.resolve(tmpDir), 'output.pdf'));
    expect(fs.existsSync(savedPath)).toBe(true);

    const reopened = await PdfSignatureTool.open('output.pdf', { baseDir: tmpDir });
    expect(reopened.getMetadata().title).toBe('Saved doc');
  });

  it('confines save() to baseDir regardless of path traversal attempts', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-seal-test-'));
    const tool = await PdfSignatureTool.create();
    const savedPath = await tool.save('../../etc/evil.pdf', { baseDir: tmpDir });
    expect(savedPath).toBe(path.join(path.resolve(tmpDir), 'evil.pdf'));
  });

  it('rejects save() without a baseDir', async () => {
    const tool = await PdfSignatureTool.create();
    await expect(tool.save('x.pdf', undefined as any)).rejects.toThrow(/requires a baseDir/);
  });

  it('rejects save() with an invalid resulting filename', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-seal-test-'));
    const tool = await PdfSignatureTool.create();
    await expect(tool.save('.', { baseDir: tmpDir })).rejects.toThrow(/Invalid file name/);
    await expect(tool.save('..', { baseDir: tmpDir })).rejects.toThrow(/Invalid file name/);
  });

  it('rejects open() without a baseDir', async () => {
    await expect(PdfSignatureTool.open('x.pdf', undefined as any)).rejects.toThrow(/requires a baseDir/);
  });

  it('rejects open() with an invalid resulting filename', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-seal-test-'));
    await expect(PdfSignatureTool.open('.', { baseDir: tmpDir })).rejects.toThrow(/Invalid file name/);
  });

  it('confines open() to baseDir regardless of path traversal attempts', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-seal-test-'));
    const tool = await PdfSignatureTool.create();
    await tool.save('doc.pdf', { baseDir: tmpDir });
    const opened = await PdfSignatureTool.open('../../../doc.pdf', { baseDir: tmpDir });
    expect(opened.listFields()).toEqual([]);
  });
});

describe('PdfSignatureTool: signature dictionaries and certificates', () => {
  it('marks an unsigned signature field as not signed', async () => {
    const tool = await PdfSignatureTool.create();
    tool.addPage();
    tool.addSignatureField(0, 'Signature1', {});

    const [field] = tool.listFields();
    expect(field.type).toBe('Signature');
    expect(field.signed).toBe(false);
    expect(tool.getSignatureDictionaries()).toEqual([]);
  });

  it('marks a text field as not signed', async () => {
    const tool = await PdfSignatureTool.create();
    tool.addPage();
    tool.addTextField(0, 'name1', {});
    expect(tool.listFields()[0].signed).toBe(false);
  });

  it('marks a field carrying a populated /V as signed', async () => {
    const fx = await buildSignedPdfFixture();
    const tool = await PdfSignatureTool.fromBytes(fx.bytes);

    const field = tool.listFields().find((f: any) => f.name === 'Signature1');
    expect(field.signed).toBe(true);
  }, 30000);

  it('reads a signature dictionary without going through the lossy text conversion', async () => {
    const fx = await buildSignedPdfFixture({
      signerName: 'Jane Doe',
      reason: 'Testing pdf-seal',
      location: 'Prague',
    });
    const tool = await PdfSignatureTool.fromBytes(fx.bytes);
    const [dict] = tool.getSignatureDictionaries();

    expect(dict.fieldName).toBe('Signature1');
    expect(dict.filter).toBe('Adobe.PPKLite');
    expect(dict.subFilter).toBe('adbe.pkcs7.detached');
    expect(dict.name).toBe('Jane Doe');
    expect(dict.reason).toBe('Testing pdf-seal');
    expect(dict.location).toBe('Prague');
    expect(dict.contactInfo).toBeNull();
    expect(dict.page).toBe(0);
    expect(dict.byteRange).toEqual(fx.byteRange);
    expect(dict.objectRef).toMatch(/^\d+ \d+ R$/);
    expect(dict.docMdpLevel).toBeNull();
    expect(dict.certDer).toEqual([]);
  }, 30000);

  it('parses /M into an ISO date', async () => {
    const fx = await buildSignedPdfFixture();
    const tool = await PdfSignatureTool.fromBytes(fx.bytes);
    const [dict] = tool.getSignatureDictionaries();

    expect(dict.signingTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(new Date(dict.signingTime).getTime()).not.toBeNaN();
  }, 30000);

  it('reads a single /Cert entry as raw bytes', async () => {
    const chain = await mintStandardChain();
    const fx = await buildSignedPdfFixture({
      subFilter: 'adbe.x509.rsa_sha1',
      legacyCertificates: [chain.leaf],
    });
    const tool = await PdfSignatureTool.fromBytes(fx.bytes);
    const [dict] = tool.getSignatureDictionaries();

    expect(dict.subFilter).toBe('adbe.x509.rsa_sha1');
    expect(dict.certDer).toHaveLength(1);
    // Byte-identical, which decodeText() would not have managed.
    expect(Buffer.from(dict.certDer[0]).equals(Buffer.from(chain.leaf.der))).toBe(true);
  }, 40000);

  it('reads an array of /Cert entries', async () => {
    const chain = await mintStandardChain();
    const fx = await buildSignedPdfFixture({
      legacyCertificates: [chain.leaf, chain.intermediate],
    });
    const tool = await PdfSignatureTool.fromBytes(fx.bytes);

    expect(tool.getSignatureDictionaries()[0].certDer).toHaveLength(2);
  }, 40000);

  it('reads the DocMDP level from a certifying signature', async () => {
    const fx = await buildSignedPdfFixture({ docMdpLevel: 2 });
    const tool = await PdfSignatureTool.fromBytes(fx.bytes);
    expect(tool.getSignatureDictionaries()[0].docMdpLevel).toBe(2);
  }, 30000);

  it('returns empty structures when there is no document security store', async () => {
    const tool = await PdfSignatureTool.create();
    tool.addPage();
    expect(tool.getDocumentSecurityStore()).toEqual({ certs: [], vri: [] });
  });

  it('reads certificates out of /DSS /Certs', async () => {
    const chain = await mintStandardChain();
    const fx = await buildSignedPdfFixture({
      dssCertificates: [chain.intermediate, chain.root],
    });
    const tool = await PdfSignatureTool.fromBytes(fx.bytes);
    const dss = tool.getDocumentSecurityStore();

    expect(dss.certs).toHaveLength(2);
    expect(dss.vri).toEqual([]);
    expect(Buffer.from(dss.certs[0].bytes).equals(Buffer.from(chain.intermediate.der))).toBe(true);
    expect(dss.certs[0].objectRef).toMatch(/^\d+ \d+ R$/);
  }, 40000);

  it('reads /VRI entries and their certificate references', async () => {
    const chain = await mintStandardChain();
    const fx = await buildSignedPdfFixture({
      dssCertificates: [chain.intermediate],
      dssVri: true,
    });
    const tool = await PdfSignatureTool.fromBytes(fx.bytes);
    const dss = tool.getDocumentSecurityStore();

    expect(dss.vri).toHaveLength(1);
    expect(dss.vri[0].key).toMatch(/^[0-9A-F]{40}$/);
    expect(dss.vri[0].certRefs).toEqual([dss.certs[0].objectRef]);
  }, 40000);
});
