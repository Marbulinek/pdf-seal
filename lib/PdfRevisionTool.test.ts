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
});
