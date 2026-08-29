import { describe, it, expect } from 'vitest';
import PdfSignatureTool from './PdfSignatureTool';
import PdfRevisionTool from './PdfRevisionTool';

describe('PdfRevisionTool', () => {
  it('reports no changes between identical snapshots', async () => {
    const tool = await PdfSignatureTool.create();
    const bytes = await tool.toBytes();

    const diff = await PdfRevisionTool.diffSnapshotBytes(bytes, bytes);
    expect(diff.byteLengthDelta).toBe(0);
    expect(diff.fieldChanges.added).toEqual([]);
    expect(diff.fieldChanges.removed).toEqual([]);
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
    expect(firstRev.metadata.modificationDate.getTime()).not.toBe(secondRev.metadata.modificationDate.getTime());
    expect(secondRev.metadata.modificationDate.getTime()).toBeGreaterThan(firstRev.metadata.modificationDate.getTime());
  });
});
