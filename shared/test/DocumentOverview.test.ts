import { describe, it, expect } from 'vitest';
import { curateRawEntries, overviewItems, atAGlanceChips } from '../DocumentOverview';

describe('curateRawEntries', () => {
  it('relabels keys, decodes flags, formats rects and drops structural keys', () => {
    const rows = curateRawEntries({
      Type: '/Annot', P: '3 0 R', T: 'sig1', FT: '/Sig', F: '132', Ff: '3', Rect: '[ 10.123 20 110.123 70 ]',
    });
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(byKey.Type).toBeUndefined();
    expect(byKey.P).toBeUndefined();
    expect(byKey.T.label).toBe('Name');
    expect(byKey.F.value).toBe('Print, Locked');
    expect(byKey.Ff.value).toBe('ReadOnly, Required');
    expect(byKey.Rect.value).toBe('10.1, 20 · 100 × 50 pt');
  });

  it('summarizes ByteRange, binary, long strings and long number arrays', () => {
    const rows = curateRawEntries({
      ByteRange: '[ 0 100 200 50 ]',
      Contents: `<${'ab'.repeat(100)}>`,
      Note: 'x'.repeat(300),
      Pts: '[ 1 2 3 4 5 6 7 8 9 10 ]',
      Small: '[ 1 2 3 ]',
    });
    const v = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    expect(v.ByteRange).toBe('bytes 0–100 and 200–250');
    expect(v.Contents).toBe('binary data, 100 bytes');
    expect(v.Note).toBe(`${'x'.repeat(200)}… (300 chars)`);
    expect(v.Pts).toBe('10 numbers');
    expect(v.Small).toBe('[ 1 2 3 ]');
  });

  it('handles missing input', () => {
    expect(curateRawEntries(null)).toEqual([]);
  });
});

describe('overviewItems', () => {
  it('flattens every kind and sorts by page then top-to-bottom', () => {
    const items = overviewItems({
      fields: [
        { name: 'low', type: 'TextField', page: 0, rect: { x: 0, y: 10, width: 10, height: 10 }, raw: { V: 'hi' } },
        { name: 'sig', type: 'Signature', page: 1, rect: { x: 0, y: 0, width: 10, height: 10 }, raw: {} },
      ],
      stamps: [{ id: 's1', page: 0, rect: { x: 0, y: 500, width: 10, height: 10 }, kind: 'text', text: 'APPROVED' }],
      annotations: [
        { ref: '9 0 R', page: 0, rect: { x: 0, y: 300, width: 10, height: 10 }, subtype: 'Link', kind: 'link', uri: 'https://a.b' },
        { ref: '10 0 R', page: 0, rect: null, subtype: 'Highlight', kind: 'markup' },
      ],
    });
    expect(items.map((i) => `${i.kind}:${i.key}`)).toEqual(['stamp:s1', 'link:9 0 R', 'field:low', 'comment:10 0 R', 'signature:sig']);
    expect(items[0].label).toBe('APPROVED');
    expect(items[2].status).toBe('Filled');
    expect(items[4].status).toBe('Empty');
    expect(items[1].status).toBe('URL');
  });
});

describe('atAGlanceChips', () => {
  it('returns only chips that apply', () => {
    expect(atAGlanceChips({ features: {} }, [])).toEqual([]);
    const chips = atAGlanceChips(
      { features: { signatureCount: 2, encrypted: true, pdfA: 'Yes', javascript: true, attachmentCount: 1, incrementalUpdates: 3 } },
      [
        { type: 'TextField', raw: {} },
        { type: 'TextField', raw: {}, readOnly: true },
        { type: 'Signature', raw: { V: '1 0 R' } },
      ],
    );
    expect(chips.map((c) => c.label)).toEqual([
      'Signed ×2', '1 field to fill', 'Encrypted', 'PDF/A', 'Contains JavaScript', '1 attachment', '3 updates',
    ]);
    expect(chips.find((c) => c.id === 'js')!.tone).toBe('warning');
    expect(chips.find((c) => c.id === 'updates')!.goto).toBe('revisions');
  });

  it('adds a certification chip per DocMDP level', () => {
    const chip = (certification: number | null) =>
      atAGlanceChips({ features: { certification } }, []).find((c) => c.id === 'certified');
    expect(chip(null)).toBeUndefined();
    expect(chip(1)).toMatchObject({ label: 'Certified · no changes allowed', tone: 'warning' });
    expect(chip(1)!.title).toMatch(/invalidate/);
    expect(chip(2)).toMatchObject({ label: 'Certified · form filling & signing allowed', tone: 'neutral' });
    expect(chip(3)).toMatchObject({ label: 'Certified · filling, signing & comments allowed', tone: 'neutral' });
  });

  it('hides a single revision boundary', () => {
    expect(atAGlanceChips({ features: { incrementalUpdates: 1 } }, [])).toEqual([]);
  });
});
