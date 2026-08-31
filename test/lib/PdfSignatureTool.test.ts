import { describe, it, expect } from 'vitest';
import PdfSignatureTool from '../../lib/PdfSignatureTool';

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

  it('round-trips an explicitly set modification date', async () => {
    const tool = await PdfSignatureTool.create();
    const modDate = new Date('2026-01-15T10:00:00.000Z');
    tool.setMetadata({ modificationDate: modDate });

    const bytes = await tool.toBytes();
    const reloaded = await PdfSignatureTool.fromBytes(bytes);
    expect(reloaded.getMetadata().modificationDate?.getTime()).toBe(modDate.getTime());
  });
});
