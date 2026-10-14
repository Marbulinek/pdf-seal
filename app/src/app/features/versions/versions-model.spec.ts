import type { RawObjectPreview, RevisionDiff } from '../../core/models';
import {
  bareRawObject,
  checklistItems,
  chipMatchesFilter,
  compareVerdict,
  diffSections,
  noPreviewReasonText,
  objectChangeCount,
  objectChipGroups,
  rawObjectCategories,
} from './versions-model';

function preview(key: string, patch: Partial<RawObjectPreview> = {}): RawObjectPreview {
  return { ...bareRawObject(key), ...patch };
}

function diff(patch: Partial<RevisionDiff> = {}): RevisionDiff {
  return {
    byteLengthDelta: 1024,
    pageCountDelta: 0,
    metadataChanges: [],
    fieldChanges: { added: [], removed: [], modified: [] },
    signatureChanges: { added: [], removed: [] },
    stampChanges: { added: [], removed: [], modified: [] },
    objectChanges: { added: [], removed: [], modified: [], truncated: false },
    ...patch,
  };
}

describe('versions model', () => {
  it('builds a verdict from the checklist counts and headline events', () => {
    const d = diff({
      checklist: {
        pagesUnchanged: true,
        pagesChangedCount: 0,
        textUnchanged: true,
        textChangedCount: 0,
        imagesUnchanged: true,
        imagesChangedCount: 0,
        signatureFieldsUnchanged: false,
        signatureFieldsChangedCount: 1,
        acroFormUnchanged: false,
        acroFormChangedCount: 2,
        stampsUnchanged: true,
        stampsChangedCount: 0,
        metadataUnchanged: true,
        metadataChangedCount: 0,
        signatureUnchanged: true,
        signatureChangedCount: 0,
      },
      fieldChanges: { added: [{ name: 'Sig1', type: 'Signature', page: 0, rect: null }], removed: [], modified: [] },
    });
    expect(compareVerdict(d)).toBe('3 changes · 1 field(s) added · +1.0 KB file size');

    const items = checklistItems(d);
    expect(items).toHaveLength(8);
    expect(items[0]).toMatchObject({ label: 'Pages', unchanged: true, detail: 'Unchanged', target: null });
    expect(items[3]).toMatchObject({ label: 'Signature fields', detail: '1 field(s) changed', target: { tab: 'details', section: 'fields' } });
  });

  it('reports "No changes detected" when nothing moved', () => {
    expect(compareVerdict(diff({ byteLengthDelta: 0 }))).toBe('No changes detected · ±0 B file size');
  });

  it('builds the Details sections with locatable rows only where geometry exists', () => {
    const sections = diffSections(
      diff({
        metadataChanges: [{ key: 'Title', before: null, after: 'New' }],
        fieldChanges: {
          added: [{ name: 'A', type: 'Signature', page: 1, rect: { x: 1, y: 2, width: 30, height: 10 } }],
          removed: [{ name: 'B', type: 'Signature', page: null, rect: null }],
          modified: [{ name: 'C', page: 0, rect: { x: 0, y: 0, width: 10, height: 10 }, changes: [{ key: 'required', before: false, after: true }] }],
        },
        signatureChanges: {
          added: [
            {
              fieldName: 'S',
              name: 'Alex',
              reason: null,
              location: null,
              signingTime: null,
              subFilter: null,
              contactInfo: null,
              byteRange: null,
              page: 0,
              rect: { x: 0, y: 0, width: 50, height: 20 },
            },
          ],
          removed: [],
        },
      }),
    );
    expect(sections.map((s) => s.key)).toEqual(['metadata', 'fields', 'stamps', 'signature']);
    const [metadata, fields, stamps, signature] = sections;
    expect(metadata.rows[0].changes).toEqual([{ key: '', before: '(empty)', after: 'New' }]);
    expect(fields.rows.map((r) => r.badge)).toEqual(['added', 'removed', 'modified']);
    expect(fields.rows[0].locate).toMatchObject({ page: 1, side: 'to', key: 'field-added:A' });
    expect(fields.rows[1].locate).toBeNull();
    expect(fields.rows[2].changes).toEqual([{ key: 'required', before: 'false', after: 'true' }]);
    expect(stamps.rows).toEqual([]);
    expect(signature.rows[0]).toMatchObject({ badgeText: 'signed', text: 'Alex' });
  });

  it('groups raw-object chips and filters them', () => {
    const d = diff({
      objectChanges: {
        added: ['1 0 R'],
        removed: ['2 0 R'],
        modified: [],
        addedDetails: [preview('1 0 R', { category: 'Widget', page: 0, previewMode: 'rects', rects: [{ x: 0, y: 0, width: 50, height: 20 }] })],
        truncated: false,
      },
    });
    const groups = objectChipGroups(d, 1, 2);
    expect(groups.map((g) => g.cls)).toEqual(['chip-added', 'chip-removed']);
    const [added] = groups[0].chips;
    expect(added).toMatchObject({ objectId: 'chip-added:1 0 R', revisionIndex: 2, canShowOnPage: true, showLabel: 'Show on page 1', side: 'to' });
    expect(groups[1].chips[0]).toMatchObject({ side: 'from', revisionIndex: 1, canShowOnPage: false });
    expect(objectChangeCount(d)).toBe(2);
    expect(rawObjectCategories(groups)).toEqual(['Widget']);

    expect(chipMatchesFilter(added, { term: '1 0', categories: [], locatableOnly: false })).toBe(true);
    expect(chipMatchesFilter(added, { term: 'nope', categories: [], locatableOnly: false })).toBe(false);
    expect(chipMatchesFilter(groups[1].chips[0], { term: '', categories: [], locatableOnly: true })).toBe(false);
    expect(chipMatchesFilter(added, { term: '', categories: ['Font'], locatableOnly: false })).toBe(false);
  });

  it('explains why an object has no on-page preview', () => {
    expect(noPreviewReasonText({ page: 2, noPreviewReason: 'no-geometry' })).toContain('page 3');
    expect(noPreviewReasonText({ page: null, noPreviewReason: 'document-level' })).toContain('document-level');
  });
});
