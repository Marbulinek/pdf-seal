import { describe, it, expect } from 'vitest';
import { PDFName, PDFString, PDFHexString, PDFRef } from 'pdf-lib';
import PdfSignatureTool from '../../lib/PdfSignatureTool';
import PdfRevisionTool from '../../lib/PdfRevisionTool';
import { applyCertificateOperation } from '../../lib/PdfCertificateModifier';
import { buildSignedPdfFixture } from './helpers/pdfSigner';

describe('PdfRevisionTool.findRevisionBoundaries', () => {
  it('finds every startxref/%%EOF boundary in raw bytes', () => {
    const text = 'garbage\nstartxref\n123\n%%EOF\nmore garbage\nstartxref\n456\n%%EOF\ntrailing';
    const bytes = Buffer.from(text, 'latin1');
    const boundaries = PdfRevisionTool.findRevisionBoundaries(bytes);
    expect(boundaries).toHaveLength(2);
    expect(boundaries[0]).toMatchObject({ index: 1, xrefOffset: 123 });
    expect(boundaries[1]).toMatchObject({ index: 2, xrefOffset: 456 });
    expect(boundaries[1].endOffset).toBeGreaterThan(boundaries[0].endOffset);
  });

  it('returns an empty array when there is no boundary at all', () => {
    expect(PdfRevisionTool.findRevisionBoundaries(Buffer.from('not a pdf'))).toEqual([]);
  });
});

describe('PdfRevisionTool.summarizeIndependentSnapshots', () => {
  it('reports no changes between identical snapshots', async () => {
    const tool = await PdfSignatureTool.create();
    const bytes = await tool.toBytes();

    const diff = await PdfRevisionTool.diffSnapshotBytes(bytes, bytes);
    expect(diff.byteLengthDelta).toBe(0);
    expect(diff.fieldChanges.added).toEqual([]);
    expect(diff.fieldChanges.removed).toEqual([]);
  });

  it('produces a rich changeSummary for a valid snapshot', async () => {
    const tool = await PdfSignatureTool.create();
    tool.addPage();
    tool.addSignatureField(0, 'sig1', {});
    tool.addTextField(0, 'name1', {});
    tool.setMetadata({ title: 'Snapshot', author: 'CI' });
    const bytes = await tool.toBytes();

    const [summary] = await PdfRevisionTool.summarizeIndependentSnapshots([bytes]);
    expect(summary.parseError).toBeNull();
    expect(summary.index).toBe(1);
    expect(summary.isFinal).toBe(true);
    expect(summary.byteLength).toBe(bytes.length);
    expect(summary.pageCount).toBe(1);
    expect(summary.fields).toHaveLength(2);
    expect(summary.changeSummary.fieldCount).toBe(2);
    expect(summary.changeSummary.pageCount).toBe(1);
    expect(summary.changeSummary.metadataFieldCount).toBeGreaterThanOrEqual(2);
    expect(summary.changeSummary.acroFormCount).toBeGreaterThan(0);
    expect(summary.changeSummary.signatureCount).toBe(0);
  });

  it('reports a parse error for bytes that are not a valid standalone PDF', async () => {
    const [summary] = await PdfRevisionTool.summarizeIndependentSnapshots([Buffer.from('not a pdf at all')]);
    expect(summary.parseError).toBeTruthy();
    expect(summary.pageCount).toBeNull();
    expect(summary.metadata).toBeNull();
    expect(summary.fields).toBeNull();
    expect(summary.signatures).toEqual([]);
  });

  it('counts text fields and text annotations together, and images separately', async () => {
    const tool = await PdfSignatureTool.create();
    tool.addPage();
    tool.addTextField(0, 'name1', {});
    const pdfDoc = (tool as any).pdfDoc;
    const page = pdfDoc.getPages()[0];
    const pngBytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    );
    const img = await pdfDoc.embedPng(pngBytes);
    page.drawImage(img, { x: 0, y: 0, width: 10, height: 10 });
    const bytes = await tool.toBytes();

    const [summary] = await PdfRevisionTool.summarizeIndependentSnapshots([bytes]);
    expect(summary.changeSummary.textCount).toBeGreaterThanOrEqual(1);
    expect(summary.changeSummary.imageCount).toBe(1);
  });

  it('gives each revision its own modification date when fields are added at different times', async () => {
    // Mirrors what server.ts's mutating routes now do: stamp modificationDate
    // to "now" right before saving, so each snapshot's own ModDate reflects
    // when it was actually produced rather than inheriting the original file's.
    const first = await PdfSignatureTool.create();
    first.addPage();
    first.addSignatureField(0, 'signature1', { x: 10, y: 10, width: 150, height: 50 });
    first.setMetadata({ modificationDate: new Date('2026-01-01T00:00:00.000Z') });
    const firstBytes = await first.toBytes();

    const second = await PdfSignatureTool.fromBytes(firstBytes);
    second.addSignatureField(0, 'signature2', { x: 10, y: 80, width: 150, height: 50 });
    second.setMetadata({ modificationDate: new Date('2026-01-02T00:00:00.000Z') });
    const secondBytes = await second.toBytes();

    const revisions = await PdfRevisionTool.summarizeIndependentSnapshots([firstBytes, secondBytes]);
    expect(revisions).toHaveLength(2);
    const [firstRev, secondRev] = revisions;
    expect(firstRev.isFinal).toBe(false);
    expect(secondRev.isFinal).toBe(true);
    expect(firstRev.metadata?.modificationDate.getTime()).not.toBe(secondRev.metadata?.modificationDate.getTime());
    expect(secondRev.metadata?.modificationDate.getTime()).toBeGreaterThan(firstRev.metadata?.modificationDate.getTime());
  });
});

describe('PdfRevisionTool.diffSnapshotBytes', () => {
  it('rejects diffing when one side cannot be parsed as a standalone PDF', async () => {
    const tool = await PdfSignatureTool.create();
    const bytes = await tool.toBytes();
    await expect(PdfRevisionTool.diffSnapshotBytes(bytes, Buffer.from('garbage'))).rejects.toThrow(
      /could not be parsed as a standalone PDF/,
    );
  });

  it('detects a signature field added between revisions', async () => {
    const before = await PdfSignatureTool.create();
    before.addPage();
    const beforeBytes = await before.toBytes();

    const after = await PdfSignatureTool.create();
    after.addPage();
    after.addSignatureField(0, 'signature1', { x: 10, y: 10, width: 150, height: 50 });
    const afterBytes = await after.toBytes();

    const diff = await PdfRevisionTool.diffSnapshotBytes(beforeBytes, afterBytes);
    expect(diff.fieldChanges.added.map((f) => f.name)).toContain('signature1');
  });

  it('detects a metadata change between revisions', async () => {
    const before = await PdfSignatureTool.create();
    before.setMetadata({ title: 'Original' });
    const beforeBytes = await before.toBytes();

    const after = await PdfSignatureTool.fromBytes(beforeBytes);
    after.setMetadata({ title: 'Updated' });
    const afterBytes = await after.toBytes();

    const diff = await PdfRevisionTool.diffSnapshotBytes(beforeBytes, afterBytes);
    expect(diff.metadataChanges.length).toBeGreaterThan(0);
  });

  describe('a richly mutated revision (fields, content stream, image, xmp, dangling ref, fake signature)', () => {
    async function buildScenario() {
      const before = await PdfSignatureTool.create();
      before.addPage();
      before.addSignatureField(0, 'sig1', { x: 10, y: 10, width: 100, height: 30 });
      before.addTextField(0, 'name1', { x: 10, y: 60, width: 100, height: 20 });

      const pdfDocBefore: any = (before as any).pdfDoc;
      const contextBefore = pdfDocBefore.context;
      const pageBefore = pdfDocBefore.getPages()[0];
      const beforeText = '50 400 100 30 re f\n10 10 m 100 10 l S\n/F1 12 Tf 20 30 Td (Hello) Tj\n';
      const beforeStreamRef = contextBefore.register(contextBefore.stream(beforeText, {}));
      pageBefore.node.set(PDFName.of('Contents'), beforeStreamRef);
      before.setMetadata({ title: 'Before', modificationDate: new Date('2026-01-01T00:00:00.000Z') });

      const beforeBytes = await before.toBytes();
      const after = await PdfSignatureTool.fromBytes(beforeBytes);
      const pdfDocAfter: any = (after as any).pdfDoc;
      const contextAfter = pdfDocAfter.context;

      // Rewrite the SAME content-stream object (same ref) with different
      // drawing operators, so the diff sees one modified object rather than
      // an unrelated added/removed pair.
      const pageAfter = pdfDocAfter.getPages()[0];
      const existingContentsRef = pageAfter.node.get(PDFName.of('Contents'));
      const afterText = '10 10 m 100 10 l S\n/F1 14 Tf 25 35 Td (Hello World) Tj\n60 500 50 20 re f\n';
      contextAfter.assign(existingContentsRef, contextAfter.stream(afterText, {}));

      after.removeField('sig1');
      after.addSignatureField(0, 'sig2', { x: 10, y: 10, width: 100, height: 30 });
      after.addPage();
      // diffFields() only tracks type/required/readOnly/page (not rect), so
      // moving the field to the new page is what registers as "modified".
      after.setFieldPage('name1', 1);
      after.setMetadata({ title: 'After', modificationDate: new Date('2026-01-02T00:00:00.000Z') });

      // A tiny embedded image, to exercise the "image" category/count.
      const pngBytes = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64',
      );
      const img = await pdfDocAfter.embedPng(pngBytes);
      pageAfter.drawImage(img, { x: 0, y: 0, width: 5, height: 5 });

      // An XMP metadata packet, to exercise the "xmp" category.
      const xmpRef = contextAfter.register(contextAfter.stream('<x:xmpmeta>after</x:xmpmeta>', { Type: 'Metadata', Subtype: 'XML' }));
      pdfDocAfter.catalog.set(PDFName.of('Metadata'), xmpRef);

      // An object with a reference to a nonexistent object, to exercise
      // integrity's dangling-reference check.
      const danglingRef = contextAfter.register(contextAfter.obj({}));
      contextAfter.lookup(danglingRef).set(PDFName.of('Bad'), PDFRef.of(999999, 0));

      // A fake, unsigned-in-practice /V signature dict on sig2 whose
      // /ByteRange doesn't cover the whole revision, to exercise the
      // byte-range coverage integrity check.
      const sig2Field = pdfDocAfter.getForm().getFieldMaybe('sig2');
      const vDict = contextAfter.obj({
        Type: 'Sig',
        Filter: 'Adobe.PPKLite',
        SubFilter: 'adbe.pkcs7.detached',
        Name: PDFString.of('Tester'),
        ByteRange: [0, 10, 20, 5],
        Contents: PDFHexString.of('AABBCC'),
      });
      sig2Field.acroField.dict.set(PDFName.of('V'), vDict);

      const afterBytes = await after.toBytes();
      const diff = await PdfRevisionTool.diffSnapshotBytes(beforeBytes, afterBytes);
      return { beforeBytes, afterBytes, diff };
    }

    it('reports field additions, removals, and modifications', async () => {
      const { diff } = await buildScenario();
      expect(diff.fieldChanges.added.map((f: any) => f.name)).toEqual(['sig2']);
      expect(diff.fieldChanges.removed.map((f: any) => f.name)).toEqual(['sig1']);
      const modifiedNames = diff.fieldChanges.modified.map((f: any) => f.name);
      expect(modifiedNames).toContain('name1');
    });

    it('reports the page count delta and metadata changes', async () => {
      const { diff } = await buildScenario();
      expect(diff.pageCountDelta).toBe(1);
      expect(diff.metadataChanges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: 'title', before: 'Before', after: 'After' }),
        ]),
      );
    });

    it('classifies every changed object into the right human-facing category', async () => {
      const { diff } = await buildScenario();
      const categoryValues = new Set(Object.values(diff.objectChanges.categories));
      for (const cat of ['content', 'page', 'signatureField', 'formField', 'acroform', 'image', 'xmp']) {
        expect(categoryValues.has(cat)).toBe(true);
      }
    });

    it('extracts precise before/after rects from the content-stream diff (rect, line and text ops)', async () => {
      const { diff } = await buildScenario();
      const contentDetail = diff.objectChanges.modifiedDetails.find((d: any) => d.category === 'Page Content');
      expect(contentDetail).toBeTruthy();
      expect(contentDetail.previewMode).toBe('rects');
      expect(contentDetail.hasVisualLocation).toBe(true);
      expect(contentDetail.streamDiff.available).toBe(true);
      expect(contentDetail.streamDiff.contentUnchanged).toBe(false);
      expect(contentDetail.streamDiff.added).toEqual(
        expect.arrayContaining(['/F1 14 Tf 25 35 Td (Hello World) Tj', '60 500 50 20 re f']),
      );
      expect(contentDetail.streamDiff.removed).toEqual(
        expect.arrayContaining(['50 400 100 30 re f', '/F1 12 Tf 20 30 Td (Hello) Tj']),
      );
      // One rect per drawing op (re / m..l..S / Tf..Td..Tj) on each side.
      expect(contentDetail.rects.length).toBeGreaterThanOrEqual(3);
      expect(contentDetail.classifications).toContain('content-stream');
      expect(contentDetail.classifications).toContain('visual-content');
    });

    it('describes the removed signature field with its own preview details', async () => {
      const { diff } = await buildScenario();
      const removedSig = diff.objectChanges.removedDetails.find((d: any) => d.fieldName === 'sig1');
      expect(removedSig).toBeTruthy();
      expect(removedSig.category).toBe('Signature');
      expect(removedSig.previewMode).toBe('rects');
      expect(removedSig.dictionaryChanges.every((c: any) => c.status === 'removed')).toBe(true);
      expect(removedSig.label).toContain('sig1');
    });

    it('flags a dangling reference and insufficient signature byte-range coverage as integrity issues', async () => {
      const { diff } = await buildScenario();
      expect(diff.integrity.ok).toBe(false);
      expect(diff.integrity.issues.some((msg: string) => /references missing object/.test(msg))).toBe(true);
      expect(diff.integrity.issues.some((msg: string) => /sig2:.*ByteRange/.test(msg))).toBe(true);
    });

    it('reports the added fake signature in signatureChanges', async () => {
      const { diff } = await buildScenario();
      expect(diff.signatureChanges.added.map((s: any) => s.fieldName)).toEqual(['sig2']);
      expect(diff.signatureChanges.removed).toEqual([]);
    });

    it('rolls object-level changes up into the revision checklist', async () => {
      const { diff } = await buildScenario();
      const checklist = diff.checklist;
      expect(checklist.pagesUnchanged).toBe(false);
      expect(checklist.textUnchanged).toBe(false);
      expect(checklist.imagesUnchanged).toBe(false);
      expect(checklist.imagesChangedCount).toBe(1);
      expect(checklist.signatureFieldsUnchanged).toBe(false);
      expect(checklist.acroFormUnchanged).toBe(false);
      expect(checklist.metadataUnchanged).toBe(false);
      expect(checklist.metadataChangedCount).toBeGreaterThan(0);
      expect(checklist.signatureUnchanged).toBe(false);
      expect(checklist.signatureChangedCount).toBe(1);
    });
  });

  it('reports a clean checklist and passing integrity check when nothing changed', async () => {
    const tool = await PdfSignatureTool.create();
    tool.addPage();
    tool.addSignatureField(0, 'sig1', {});
    const bytes = await tool.toBytes();

    const diff = await PdfRevisionTool.diffSnapshotBytes(bytes, bytes);
    expect(diff.checklist).toMatchObject({
      pagesUnchanged: true,
      textUnchanged: true,
      imagesUnchanged: true,
      signatureFieldsUnchanged: true,
      acroFormUnchanged: true,
      metadataUnchanged: true,
      signatureUnchanged: true,
    });
    expect(diff.integrity).toEqual({ ok: true, issues: [] });
  });

  it('marks a content-stream diff unavailable/truncated when it exceeds the diffable unit cap', async () => {
    const before = await PdfSignatureTool.create();
    before.addPage();
    const pdfDocBefore: any = (before as any).pdfDoc;
    const contextBefore = pdfDocBefore.context;
    const pageBefore = pdfDocBefore.getPages()[0];
    const bigBeforeText = Array.from({ length: 2500 }, (_, i) => `${i} 0 m ${i} 1 l S`).join('\n');
    const beforeStreamRef = contextBefore.register(contextBefore.stream(bigBeforeText, {}));
    pageBefore.node.set(PDFName.of('Contents'), beforeStreamRef);
    const beforeBytes = await before.toBytes();

    const after = await PdfSignatureTool.fromBytes(beforeBytes);
    const pdfDocAfter: any = (after as any).pdfDoc;
    const contextAfter = pdfDocAfter.context;
    const pageAfter = pdfDocAfter.getPages()[0];
    const existingContentsRef = pageAfter.node.get(PDFName.of('Contents'));
    // Deliberately a different length (extra trailing content) so the raw
    // object dict itself (not just the decoded text) registers as changed --
    // diffRawObjects only compares dict-level data (incl. @rawByteLength),
    // so a same-length rewrite wouldn't be seen as "modified" at all.
    const bigAfterText = `${Array.from({ length: 2500 }, (_, i) => `${i} 9 m ${i} 8 l S`).join('\n')}\nextra content line\n`;
    contextAfter.assign(existingContentsRef, contextAfter.stream(bigAfterText, {}));
    const afterBytes = await after.toBytes();

    const diff = await PdfRevisionTool.diffSnapshotBytes(beforeBytes, afterBytes);
    const contentDetail = diff.objectChanges.modifiedDetails.find((d: any) => d.category === 'Page Content');
    expect(contentDetail).toBeTruthy();
    expect(contentDetail.streamDiff.truncated).toBe(true);
    expect(contentDetail.streamDiff.added).toEqual([]);
    expect(contentDetail.streamDiff.removed).toEqual([]);
    // No rects can be derived from a truncated diff with no added/removed lines.
    expect(contentDetail.previewMode).toBe('visual-page');
  });
});

describe('PdfRevisionTool.diffSnapshotBytes -- previewMode / noPreviewReason', () => {
  it('gives a widget with a /Rect on a known page previewMode "rects" and no noPreviewReason', async () => {
    const before = await PdfSignatureTool.create();
    before.addPage();
    const beforeBytes = await before.toBytes();

    const after = await PdfSignatureTool.create();
    after.addPage();
    after.addSignatureField(0, 'signature1', { x: 10, y: 10, width: 150, height: 50 });
    const afterBytes = await after.toBytes();

    const diff = await PdfRevisionTool.diffSnapshotBytes(beforeBytes, afterBytes);
    const widget = diff.objectChanges.addedDetails.find((d: any) => d.category === 'Signature' && d.fieldName === 'signature1');
    expect(widget).toBeTruthy();
    expect(widget.page).toBe(0);
    expect(widget.previewMode).toBe('rects');
    expect(widget.noPreviewReason).toBeNull();
  });

  it('gives a re-encoded but decoded-identical content stream previewMode "none" and reason "renders-identically"', async () => {
    const before = await PdfSignatureTool.create();
    before.addPage();
    const pdfDocBefore: any = (before as any).pdfDoc;
    const contextBefore = pdfDocBefore.context;
    const pageBefore = pdfDocBefore.getPages()[0];
    const text = '50 400 100 30 re f\n';
    const beforeStreamRef = contextBefore.register(contextBefore.stream(text, {}));
    pageBefore.node.set(PDFName.of('Contents'), beforeStreamRef);
    const beforeBytes = await before.toBytes();

    const after = await PdfSignatureTool.fromBytes(beforeBytes);
    const pdfDocAfter: any = (after as any).pdfDoc;
    const contextAfter = pdfDocAfter.context;
    const pageAfter = pdfDocAfter.getPages()[0];
    const existingContentsRef = pageAfter.node.get(PDFName.of('Contents'));
    // Same decoded text, re-written through a Flate-encoded stream so the
    // dict itself (Filter, @rawByteLength) differs even though nothing
    // about what actually renders has changed.
    contextAfter.assign(existingContentsRef, contextAfter.flateStream(text, {}));
    const afterBytes = await after.toBytes();

    const diff = await PdfRevisionTool.diffSnapshotBytes(beforeBytes, afterBytes);
    const contentDetail = diff.objectChanges.modifiedDetails.find((d: any) => d.category === 'Page Content');
    expect(contentDetail).toBeTruthy();
    expect(contentDetail.streamDiff.contentUnchanged).toBe(true);
    expect(contentDetail.previewMode).toBe('none');
    expect(contentDetail.noPreviewReason).toBe('renders-identically');
  });

  it('gives a content stream with a genuine, non-geometric change previewMode "visual-page"', async () => {
    const before = await PdfSignatureTool.create();
    before.addPage();
    // Stabilizer: give the document a real AcroForm up front, so
    // getSignatureInfo() below doesn't lazily create one independently (and
    // at a different object number) on each side of the diff.
    before.addTextField(0, 'stabilizer', {});
    const pdfDocBefore: any = (before as any).pdfDoc;
    const contextBefore = pdfDocBefore.context;
    const pageBefore = pdfDocBefore.getPages()[0];
    const beforeStreamRef = contextBefore.register(contextBefore.stream('q\n0 0 0 rg\nQ\n', {}));
    pageBefore.node.set(PDFName.of('Contents'), beforeStreamRef);
    const beforeBytes = await before.toBytes();

    const after = await PdfSignatureTool.fromBytes(beforeBytes);
    const pdfDocAfter: any = (after as any).pdfDoc;
    const contextAfter = pdfDocAfter.context;
    const pageAfter = pdfDocAfter.getPages()[0];
    const existingContentsRef = pageAfter.node.get(PDFName.of('Contents'));
    // Fill color changes -- a real content change, but not one that the
    // rect/line/text operator extraction in extractRectsFromStreamDiff can
    // turn into a precise on-page rect. A different length than the
    // "before" text so the object dict itself registers as changed.
    contextAfter.assign(existingContentsRef, contextAfter.stream('q\n0.3 0.3 0.3 rg\nQ\n', {}));
    const afterBytes = await after.toBytes();

    const diff = await PdfRevisionTool.diffSnapshotBytes(beforeBytes, afterBytes);
    const contentDetail = diff.objectChanges.modifiedDetails.find((d: any) => d.category === 'Page Content');
    expect(contentDetail).toBeTruthy();
    expect(contentDetail.streamDiff.contentUnchanged).toBe(false);
    expect(contentDetail.rects).toEqual([]);
    expect(contentDetail.previewMode).toBe('visual-page');
    expect(contentDetail.noPreviewReason).toBeNull();
  });

  it('gives a document-level object (XMP metadata) previewMode "none" and reason "document-level"', async () => {
    const before = await PdfSignatureTool.create();
    before.addPage();
    // Stabilizer -- see comment in the "visual-page" test above.
    before.addTextField(0, 'stabilizer', {});
    const beforeBytes = await before.toBytes();

    const after = await PdfSignatureTool.fromBytes(beforeBytes);
    const pdfDocAfter: any = (after as any).pdfDoc;
    const contextAfter = pdfDocAfter.context;
    const xmpRef = contextAfter.register(
      contextAfter.stream('<x:xmpmeta>after</x:xmpmeta>', { Type: 'Metadata', Subtype: 'XML' }),
    );
    pdfDocAfter.catalog.set(PDFName.of('Metadata'), xmpRef);
    const afterBytes = await after.toBytes();

    const diff = await PdfRevisionTool.diffSnapshotBytes(beforeBytes, afterBytes);
    const xmpDetail = diff.objectChanges.addedDetails.find((d: any) => d.category === 'XMP Metadata');
    expect(xmpDetail).toBeTruthy();
    expect(xmpDetail.page).toBeNull();
    expect(xmpDetail.previewMode).toBe('none');
    expect(xmpDetail.noPreviewReason).toBe('document-level');
  });

  it('gives an object with a /Rect but no resolvable page previewMode "none" and reason "page-unknown"', async () => {
    const before = await PdfSignatureTool.create();
    before.addPage();
    // Stabilizer -- see comment in the "visual-page" test above.
    before.addTextField(0, 'stabilizer', {});
    const beforeBytes = await before.toBytes();

    const after = await PdfSignatureTool.fromBytes(beforeBytes);
    const pdfDocAfter: any = (after as any).pdfDoc;
    const contextAfter = pdfDocAfter.context;
    // A free-floating annotation-shaped object: it has a /Rect, but it is
    // not attached to any page's /Annots and carries no /P -- so its page
    // genuinely cannot be resolved.
    const orphanRef = contextAfter.register(
      contextAfter.obj({ Subtype: 'Square', Rect: [10, 10, 60, 40] }),
    );
    // Force it to actually be reachable from the trailer, so it shows up
    // in the "after" object dump at all.
    pdfDocAfter.catalog.set(PDFName.of('OrphanAnnot'), orphanRef);
    const afterBytes = await after.toBytes();

    const diff = await PdfRevisionTool.diffSnapshotBytes(beforeBytes, afterBytes);
    const orphanDetail = diff.objectChanges.addedDetails.find(
      (d: any) => d.rects.length > 0 && d.page === null,
    );
    expect(orphanDetail).toBeTruthy();
    expect(orphanDetail.previewMode).toBe('none');
    expect(orphanDetail.noPreviewReason).toBe('page-unknown');
  });
});

describe('PdfRevisionTool.diffSnapshotBytes -- source dump capping', () => {
  it('marks sourceTruncated when an object has more than 40 dictionary keys', async () => {
    const before = await PdfSignatureTool.create();
    before.addPage();
    // Stabilizer -- see comment in the "visual-page" preview-mode test above.
    before.addTextField(0, 'stabilizer', {});
    const beforeBytes = await before.toBytes();

    const after = await PdfSignatureTool.fromBytes(beforeBytes);
    const pdfDocAfter: any = (after as any).pdfDoc;
    const contextAfter = pdfDocAfter.context;
    const bigDict: Record<string, string> = {};
    for (let i = 0; i < 50; i++) bigDict[`Custom${i}`] = `value${i}`;
    const bigRef = contextAfter.register(contextAfter.obj(bigDict));
    pdfDocAfter.catalog.set(PDFName.of('BigCustomDict'), bigRef);
    const afterBytes = await after.toBytes();

    const diff = await PdfRevisionTool.diffSnapshotBytes(beforeBytes, afterBytes);
    const bigDetail = diff.objectChanges.addedDetails.find(
      (d: any) => d.sourceAfter && Object.keys(d.sourceAfter).length <= 41 && Object.keys(d.sourceAfter).some((k: string) => k.startsWith('Custom')),
    );
    expect(bigDetail).toBeTruthy();
    expect(bigDetail.sourceTruncated).toBe(true);
    expect(Object.keys(bigDetail.sourceAfter).length).toBeLessThanOrEqual(41);
  });

  it('marks sourceTruncated when a /Page has more than 24 /Annots entries', async () => {
    const before = await PdfSignatureTool.create();
    before.addPage();
    const beforeBytes = await before.toBytes();

    const after = await PdfSignatureTool.fromBytes(beforeBytes);
    for (let i = 0; i < 30; i++) {
      after.addTextField(0, `field${i}`, { x: 10, y: 10 + i * 5, width: 40, height: 4 });
    }
    const afterBytes = await after.toBytes();

    const diff = await PdfRevisionTool.diffSnapshotBytes(beforeBytes, afterBytes);
    const pageDetail = diff.objectChanges.modifiedDetails.find((d: any) => d.category === 'Page');
    expect(pageDetail).toBeTruthy();
    expect(pageDetail.sourceTruncated).toBe(true);
    expect(Array.isArray(pageDetail.sourceAfter.Annots)).toBe(true);
    expect(pageDetail.sourceAfter.Annots.length).toBeLessThanOrEqual(25);
  });
});

describe('PdfRevisionTool: a rewritten signature is visible as a change', () => {
  it('detects a /Contents change even though the padded slot keeps the same length', async () => {
    // A signer reserves a fixed-size /Contents slot and pads it, so a rewritten
    // signature is byte-different but exactly as long. The change is detected
    // either way (raw values are compared), but rendering it as just
    // "<binary, N bytes>" showed the reader two identical strings and left them
    // no way to see what actually changed.
    const before = await buildSignedPdfFixture();
    const after = await applyCertificateOperation(before.bytes, {
      op: 'remove-intermediates',
      signatureField: 'Signature1',
    });

    expect(after.bytes.length).toBe(before.bytes.length);

    const diff: any = await PdfRevisionTool.diffSnapshotBytes(before.bytes, after.bytes);

    // The signature dictionary itself is reported as modified...
    expect(diff.objectChanges.modified.length).toBeGreaterThan(0);

    // ...and specifically because its /Contents differs.
    const contents = diff.objectChanges.modifiedDetails
      .flatMap((d: any) => d.dictionaryChanges ?? [])
      .find((c: any) => c.key === 'Contents');
    expect(contents).toBeDefined();
    expect(contents.status).toBe('changed');
    expect(contents.before).toMatch(/<binary, \d+ bytes, #[0-9a-f]{8}>/);
    expect(contents.after).toMatch(/<binary, \d+ bytes, #[0-9a-f]{8}>/);
    expect(contents.before).not.toBe(contents.after);
  }, 60000);
});
