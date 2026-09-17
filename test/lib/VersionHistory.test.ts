import { describe, it, expect } from 'vitest';
import {
  bytesEqual,
  classifySave,
  versionBadges,
  filterVersions,
  versionGroupDividers,
  VersionEntryLike,
} from '../../lib/VersionHistory';

function bytes(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

describe('bytesEqual', () => {
  it('is true for identical content', () => {
    expect(bytesEqual(bytes('hello'), bytes('hello'))).toBe(true);
  });

  it('is false for different lengths', () => {
    expect(bytesEqual(bytes('hello'), bytes('hello!'))).toBe(false);
  });

  it('is false for same length but different content', () => {
    expect(bytesEqual(bytes('hello'), bytes('hellO'))).toBe(false);
  });

  it('is true for two empty buffers', () => {
    expect(bytesEqual(new Uint8Array(0), new Uint8Array(0))).toBe(true);
  });
});

describe('classifySave', () => {
  it('is initial when there is no previous save', () => {
    expect(classifySave(null, bytes('%PDF-1.7 ...'))).toBe('initial');
  });

  it('is identical when the bytes did not change', () => {
    expect(classifySave(bytes('%PDF-1.7 ...'), bytes('%PDF-1.7 ...'))).toBe('identical');
  });

  it('is incremental when curr is prev plus an appended suffix', () => {
    expect(classifySave(bytes('%PDF-1.7 base'), bytes('%PDF-1.7 base + appended update'))).toBe('incremental');
  });

  it('is rewrite when curr is longer but not a byte-prefix extension of prev', () => {
    expect(classifySave(bytes('%PDF-1.7 base'), bytes('%PDF-1.7 BASE + appended update'))).toBe('rewrite');
  });

  it('is rewrite when curr is shorter than prev', () => {
    expect(classifySave(bytes('%PDF-1.7 base full'), bytes('%PDF-1.7 base'))).toBe('rewrite');
  });

  it('is rewrite when curr is same length but different content', () => {
    expect(classifySave(bytes('AAAAA'), bytes('BBBBB'))).toBe('rewrite');
  });
});

function entry(overrides: Partial<VersionEntryLike> = {}): VersionEntryLike {
  return { index: 1, ...overrides };
}

describe('versionBadges', () => {
  it('badges the first uploaded entry as Original', () => {
    const badges = versionBadges(entry({ index: 1, source: 'upload', saveKind: 'initial' }), undefined, false);
    expect(badges).toEqual([{ label: 'Original', tone: 'neutral' }]);
  });

  it('does not badge Original for an imported first entry', () => {
    const badges = versionBadges(entry({ index: 1, source: 'imported', saveKind: 'initial' }), undefined, false);
    expect(badges).toEqual([{ label: 'Imported', tone: 'neutral' }]);
  });

  it('badges an incremental update', () => {
    const badges = versionBadges(entry({ index: 2, source: 'edit', saveKind: 'incremental' }), entry({ index: 1 }), false);
    expect(badges).toContainEqual({ label: 'Incremental update', tone: 'positive' });
  });

  it('badges a full rewrite', () => {
    const badges = versionBadges(entry({ index: 2, source: 'edit', saveKind: 'rewrite' }), entry({ index: 1 }), false);
    expect(badges).toContainEqual({ label: 'Full rewrite', tone: 'neutral' });
  });

  it('omits a save-kind badge for identical (should not normally reach here, but is defensive)', () => {
    const badges = versionBadges(entry({ index: 2, source: 'edit', saveKind: 'identical' }), entry({ index: 1 }), false);
    expect(badges.some((b) => b.label === 'Full rewrite' || b.label === 'Incremental update')).toBe(false);
  });

  it('badges the last entry as Current', () => {
    const badges = versionBadges(entry({ index: 2, saveKind: 'incremental' }), entry({ index: 1 }), true);
    expect(badges).toContainEqual({ label: 'Current', tone: 'info' });
  });

  it('badges a signed entry', () => {
    const badges = versionBadges(entry({ index: 1, source: 'upload', saveKind: 'initial', signatures: [{}] }), undefined, false);
    expect(badges).toContainEqual({ label: 'Signed', tone: 'positive' });
  });

  it('warns when a rewrite follows a signed entry', () => {
    const prev = entry({ index: 1, source: 'upload', saveKind: 'initial', signatures: [{}] });
    const badges = versionBadges(entry({ index: 2, source: 'edit', saveKind: 'rewrite' }), prev, false);
    expect(badges).toContainEqual({ label: 'Earlier signatures may not verify', tone: 'warning' });
  });

  it('does not warn when a rewrite follows an unsigned entry', () => {
    const prev = entry({ index: 1, source: 'upload', saveKind: 'initial' });
    const badges = versionBadges(entry({ index: 2, source: 'edit', saveKind: 'rewrite' }), prev, false);
    expect(badges.some((b) => b.label === 'Earlier signatures may not verify')).toBe(false);
  });

  it('does not warn when the current entry is an incremental update', () => {
    const prev = entry({ index: 1, source: 'upload', saveKind: 'initial', signatures: [{}] });
    const badges = versionBadges(entry({ index: 2, source: 'edit', saveKind: 'incremental' }), prev, false);
    expect(badges.some((b) => b.label === 'Earlier signatures may not verify')).toBe(false);
  });

  it('does not warn when there is no previous entry', () => {
    const badges = versionBadges(entry({ index: 1, source: 'upload', saveKind: 'rewrite' }), undefined, false);
    expect(badges.some((b) => b.label === 'Earlier signatures may not verify')).toBe(false);
  });
});

describe('filterVersions', () => {
  const entries: VersionEntryLike[] = [
    entry({ index: 1, source: 'upload', saveKind: 'initial' }),
    entry({ index: 2, source: 'imported', saveKind: 'rewrite' }),
    entry({ index: 3, source: 'edit', saveKind: 'incremental' }),
  ];

  it('returns the same reference when the filter is off', () => {
    expect(filterVersions(entries, false)).toBe(entries);
  });

  it('keeps only incremental entries plus the base entry when the filter is on', () => {
    expect(filterVersions(entries, true)).toEqual([entries[0], entries[2]]);
  });

  it('handles a non-array input defensively', () => {
    // @ts-expect-error deliberately passing a bad type
    expect(filterVersions(null, true)).toBe(null);
  });
});

describe('versionGroupDividers', () => {
  function kinds(saveKinds: (VersionEntryLike['saveKind'])[]): VersionEntryLike[] {
    return saveKinds.map((saveKind, i) => entry({ index: i + 1, saveKind }));
  }

  it('returns no dividers when every save is a full rewrite', () => {
    expect(versionGroupDividers(kinds(['initial', 'rewrite', 'rewrite']))).toEqual([]);
  });

  it('returns no dividers when every save is incremental', () => {
    expect(versionGroupDividers(kinds(['incremental', 'incremental']))).toEqual([]);
  });

  it('divides a run of rewrites from the incremental run below it', () => {
    expect(versionGroupDividers(kinds(['initial', 'rewrite', 'incremental', 'incremental']))).toEqual([
      { position: 2, kind: 'incremental', label: 'Incremental updates', runLength: 2 },
    ]);
  });

  it('uses the singular label for a run of one', () => {
    expect(versionGroupDividers(kinds(['initial', 'incremental']))).toEqual([
      { position: 1, kind: 'incremental', label: 'Incremental update', runLength: 1 },
    ]);
  });

  it('emits a divider at every change of kind', () => {
    expect(versionGroupDividers(kinds(['initial', 'incremental', 'rewrite', 'incremental']))).toEqual([
      { position: 1, kind: 'incremental', label: 'Incremental update', runLength: 1 },
      { position: 2, kind: 'full', label: 'Full rewrite', runLength: 1 },
      { position: 3, kind: 'incremental', label: 'Incremental update', runLength: 1 },
    ]);
  });

  it('treats an identical save as part of the run it sits in', () => {
    expect(versionGroupDividers(kinds(['initial', 'identical', 'rewrite']))).toEqual([]);
    expect(versionGroupDividers(kinds(['initial', 'incremental', 'identical', 'incremental']))).toEqual([
      { position: 1, kind: 'incremental', label: 'Incremental updates', runLength: 3 },
    ]);
  });

  it('ignores legacy entries stored without a saveKind', () => {
    expect(versionGroupDividers([entry({ index: 1 }), entry({ index: 2 }), entry({ index: 3 })])).toEqual([]);
    expect(versionGroupDividers([
      entry({ index: 1, saveKind: 'rewrite' }),
      entry({ index: 2 }),
      entry({ index: 3, saveKind: 'incremental' }),
    ])).toEqual([
      { position: 2, kind: 'incremental', label: 'Incremental update', runLength: 1 },
    ]);
  });

  it('handles an empty list and a non-array input defensively', () => {
    expect(versionGroupDividers([])).toEqual([]);
    // @ts-expect-error deliberately passing a bad type
    expect(versionGroupDividers(null)).toEqual([]);
  });
});
