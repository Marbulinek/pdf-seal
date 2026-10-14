import { overviewItems } from './document-overview';
import type { DocAnnotation, DocStamp } from '../../core/models';
import { makeField, makeReport, makeSignature } from '../../testing/fixtures';
import { groupPages, overviewActionLabel, overviewSelector, overviewSheetModel, placementLines } from './overview-model';

const item = (kind: 'signature' | 'field', patch = {}) =>
  overviewItems({ fields: [makeField('Sig1', { type: kind === 'signature' ? 'Signature' : 'TextField', ...patch })] })[0];

describe('overview model', () => {
  it('folds consecutive same-size pages into one range', () => {
    const page = (index: number, sizeName = 'A4') => ({ index, sizeName, orientation: 'Portrait', rotation: 0 });
    expect(groupPages([page(0), page(1), page(2, 'Letter')])).toEqual([
      { from: 0, to: 1, sizeName: 'A4', orientation: 'Portrait', rotation: 0 },
      { from: 2, to: 2, sizeName: 'Letter', orientation: 'Portrait', rotation: 0 },
    ]);
  });

  it('selects the on-page element for an item', () => {
    expect(overviewSelector({ kind: 'signature', key: 'A"B' })).toBe('.field-overlay[data-field-name="A\\"B"]');
    expect(overviewSelector({ kind: 'link', key: 'l1' })).toBe('.overview-hotspot[data-kind="link"][data-key="l1"]');
  });

  it('describes placement in pages and millimetres', () => {
    const p = placementLines(item('signature', { extraWidgets: [{ page: 2, rect: null }] }));
    expect(p.lines).toEqual(['Page 1', '70.6 × 21.2 mm', 'Also on page 3']);
    expect(p.hasRect).toBe(true);
  });

  it('offers editing for an unsigned signature', () => {
    const m = overviewSheetModel(item('signature'), null, false);
    expect(m.title).toBe('Signature');
    expect(m.hero.badge).toEqual({ type: 'pill', text: 'Unsigned', tone: 'pending' });
    expect(m.hero.required).toBe(false);
    expect(overviewSheetModel(item('signature', { required: true }), null, false).hero.required).toBe(true);
    expect(m.actions).toEqual([{ kind: 'edit-signature', field: 'Sig1' }]);
    expect(m.traceable).toBe(true);
    expect(overviewActionLabel(m.actions[0])).toEqual({ label: 'Edit in Signatures', icon: null, primary: true });
  });

  it('reads a signed signature from the certificates report', () => {
    const signed = item('signature', { raw: { V: '5 0 R' } });
    expect(signed.status).toBe('Signed');
    expect(overviewSheetModel(signed, null, false).emptyNote).toBe('Loading signature details…');
    expect(overviewSheetModel(signed, null, true).emptyNote).toBe('Signature details could not be read.');

    const m = overviewSheetModel(signed, makeReport({ signatures: [makeSignature()] }), true);
    expect(m.hero).toMatchObject({ avatar: 'AM', badge: { type: 'cert', status: 'warn' } });
    expect(m.evidence?.length).toBeGreaterThan(0);
    expect(m.actions).toEqual([{ kind: 'open-certificates', field: 'Sig1' }]);
    expect(m.facts.find((f) => f.label === 'Coverage')?.value).toBe('Covers the whole file');
  });

  it('handles stamps, links and comments', () => {
    const stamp: DocStamp = { id: 's1', ref: '9 0 R', page: 0, rect: { x: 0, y: 0, width: 50, height: 50 }, kind: 'text', text: 'APPROVED', opacity: 0.5 };
    const link: DocAnnotation = { ref: '3 0 R', page: 0, rect: { x: 0, y: 0, width: 10, height: 10 }, subtype: 'Link', kind: 'link', uri: 'https://example.com/a' };
    const internal: DocAnnotation = { ref: '4 0 R', page: 0, rect: null, subtype: 'Link', kind: 'link', destPage: 3 };
    const comment: DocAnnotation = { ref: '5 0 R', page: 1, rect: null, subtype: 'Text', kind: 'comment', contents: 'Check this', author: 'Robin Lee' };
    const items = overviewItems({ stamps: [stamp], annotations: [link, internal, comment] });

    const s = overviewSheetModel(items.find((i) => i.kind === 'stamp')!, null, false);
    expect(s.quote).toBe('APPROVED');
    expect(s.facts.find((f) => f.label === 'Opacity')).toMatchObject({ value: '50%', meter: 50 });
    expect(s.tech[0]).toEqual({ label: 'Object', key: 'ref', value: '9 0 R' });

    const links = items.filter((i) => i.kind === 'link').map((i) => overviewSheetModel(i, null, false));
    expect(links.find((l) => l.url)?.url).toEqual({ host: 'example.com', full: 'https://example.com/a' });
    expect(links.find((l) => !l.url)?.actions).toEqual([{ kind: 'goto-page', page: 3 }]);

    const c = overviewSheetModel(items.find((i) => i.kind === 'comment')!, null, false);
    expect(c.hero).toMatchObject({ label: 'Note', avatar: 'RL' });
    expect(c.quote).toBe('Check this');
    expect(c.traceable).toBe(false);
  });
});
