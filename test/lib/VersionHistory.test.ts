import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  bytesEqual,
  classifySave,
  versionBadges,
  filterVersions,
  versionGroupDividers,
  findRevisionEndOffsets,
  classifySaveAgainstBlob,
  planVersionStorage,
  versionReadPlan,
  batchBySize,
  parseRevisionChain,
  VersionEntryLike,
} from '../../lib/VersionHistory';
import PdfSignatureTool from '../../lib/PdfSignatureTool';
import PdfRevisionTool from '../../lib/PdfRevisionTool';

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

describe('findRevisionEndOffsets', () => {
  it('matches PdfRevisionTool.findRevisionBoundaries on the same bytes', () => {
    const text = 'garbage\nstartxref\n123\n%%EOF\nmore garbage\nstartxref\n456\n%%EOF\ntrailing';
    const raw = Buffer.from(text, 'latin1');
    const expected = PdfRevisionTool.findRevisionBoundaries(raw).map((b: any) => b.endOffset);
    expect(findRevisionEndOffsets(new Uint8Array(raw))).toEqual(expected);
    expect(expected).toHaveLength(2);
  });

  it('treats a raw 0xA0 byte as whitespace, matching a latin1-decoded regex\'s \\s', () => {
    const raw = Buffer.concat([
      Buffer.from('startxref', 'latin1'),
      Buffer.from([0xa0]),
      Buffer.from('789', 'latin1'),
      Buffer.from([0xa0]),
      Buffer.from('%%EOF', 'latin1'),
    ]);
    const expected = PdfRevisionTool.findRevisionBoundaries(raw).map((b: any) => b.endOffset);
    expect(findRevisionEndOffsets(new Uint8Array(raw))).toEqual(expected);
    expect(expected).toHaveLength(1);
  });

  it('returns an empty array when there is no boundary at all', () => {
    expect(findRevisionEndOffsets(new TextEncoder().encode('not a pdf'))).toEqual([]);
  });

  it('requires at least one whitespace byte and one digit', () => {
    expect(findRevisionEndOffsets(new TextEncoder().encode('startxref%%EOF'))).toEqual([]);
    expect(findRevisionEndOffsets(new TextEncoder().encode('startxref \n%%EOF'))).toEqual([]);
  });
});

describe('classifySaveAgainstBlob', () => {
  it('classifies the first save as initial without reading anything', async () => {
    expect(await classifySaveAgainstBlob(null, bytes('hello'))).toBe('initial');
  });

  it('classifies a shorter file as a rewrite from the length alone', async () => {
    const prevBlob = new Blob([bytes('hello world')]);
    expect(await classifySaveAgainstBlob(prevBlob, bytes('hi'))).toBe('rewrite');
  });

  it('classifies byte-identical content as identical', async () => {
    const prevBlob = new Blob([bytes('hello world')]);
    expect(await classifySaveAgainstBlob(prevBlob, bytes('hello world'))).toBe('identical');
  });

  it('classifies a genuine prefix-extension as incremental', async () => {
    const prevBlob = new Blob([bytes('hello world')]);
    expect(await classifySaveAgainstBlob(prevBlob, bytes('hello world -- extended'))).toBe('incremental');
  });

  it('classifies same-length but different content as a rewrite', async () => {
    const prevBlob = new Blob([bytes('hello world')]);
    expect(await classifySaveAgainstBlob(prevBlob, bytes('HELLO WORLD'))).toBe('rewrite');
  });

  it('detects a divergence that falls on a chunk boundary', async () => {
    const prevBlob = new Blob([bytes('aaaa'.repeat(10))]); // 40 bytes
    const curr = bytes('aaaa'.repeat(10));
    curr[curr.length - 1] = 'b'.charCodeAt(0); // diverge in the final byte only
    expect(await classifySaveAgainstBlob(prevBlob, curr, 10)).toBe('rewrite');
  });

  it('matches classifySave on the same bytes for every kind', async () => {
    const prev = bytes('hello world');
    const cases: Array<[Uint8Array | null, Uint8Array]> = [
      [null, bytes('fresh')],
      [prev, bytes('hi')],
      [prev, bytes('hello world')],
      [prev, bytes('hello world!!')],
      [prev, bytes('HELLO WORLD')],
    ];
    for (const [prevBytes, currBytes] of cases) {
      const expected = classifySave(prevBytes, currBytes);
      const actual = await classifySaveAgainstBlob(prevBytes ? new Blob([prevBytes]) : null, currBytes, 3);
      expect(actual).toBe(expected);
    }
  });
});

describe('planVersionStorage', () => {
  it('stores the first save (no prior) in full', () => {
    const plan = planVersionStorage(null, 'initial', bytes('hello'));
    expect(plan).toEqual({ storage: 'full', baseKey: null, data: bytes('hello') });
  });

  it('stores a rewrite in full even when a prior version is known', () => {
    const plan = planVersionStorage({ versionKey: 'v1', byteLength: 5 }, 'rewrite', bytes('goodbye'));
    expect(plan.storage).toBe('full');
    expect(plan.baseKey).toBeNull();
  });

  it('stores an incremental save as a delta against the known prior version', () => {
    const full = bytes('hello world');
    const extended = bytes('hello world -- more');
    const plan = planVersionStorage({ versionKey: 'v1', byteLength: full.length }, 'incremental', extended);
    expect(plan.storage).toBe('delta');
    expect(plan.baseKey).toBe('v1');
    expect(Buffer.from(plan.data).toString()).toBe(' -- more');
  });

  it('falls back to full storage for an incremental save with no known prior', () => {
    const plan = planVersionStorage(null, 'incremental', bytes('hello world -- more'));
    expect(plan.storage).toBe('full');
    expect(plan.baseKey).toBeNull();
  });
});

describe('versionReadPlan', () => {
  const metas = [
    { index: 1, versionKey: 'k1', storage: 'full' as const, baseKey: null },
    { index: 2, versionKey: 'k2', storage: 'delta' as const, baseKey: 'k1' },
    { index: 3, versionKey: 'k3', storage: 'delta' as const, baseKey: 'k2' },
    { index: 4, versionKey: 'k4', storage: 'full' as const, baseKey: null },
  ];

  it('returns just the target row when it is stored in full', () => {
    expect(versionReadPlan(metas, 1)).toEqual([metas[0]]);
    expect(versionReadPlan(metas, 4)).toEqual([metas[3]]);
  });

  it('walks backward through a delta chain to its full base, base first', () => {
    expect(versionReadPlan(metas, 3)).toEqual([metas[0], metas[1], metas[2]]);
  });

  it('throws for an index that is not present', () => {
    expect(() => versionReadPlan(metas, 99)).toThrow(/not available locally/);
  });

  it('throws rather than assembling wrong bytes when a baseKey link is broken', () => {
    const broken = [
      { index: 1, versionKey: 'k1', storage: 'full' as const, baseKey: null },
      { index: 2, versionKey: 'k2-wrong-base', storage: 'delta' as const, baseKey: 'not-k1' },
    ];
    expect(() => versionReadPlan(broken, 2)).toThrow(/not available locally/);
  });

  it('throws when a delta chain runs off the front (missing base row)', () => {
    const broken = [
      { index: 2, versionKey: 'k2', storage: 'delta' as const, baseKey: 'k1' },
    ];
    expect(() => versionReadPlan(broken, 2)).toThrow(/not available locally/);
  });
});

describe('batchBySize', () => {
  it('groups items under the byte cap into one batch', () => {
    const items = [{ byteLength: 100 }, { byteLength: 200 }];
    expect(batchBySize(items, 1000, 8)).toEqual([items]);
  });

  it('starts a new batch once the byte cap would be exceeded', () => {
    const items = [{ byteLength: 3 }, { byteLength: 3 }, { byteLength: 3 }];
    expect(batchBySize(items, 8, 8)).toEqual([[items[0], items[1]], [items[2]]]);
  });

  it('starts a new batch once the count cap is reached', () => {
    const items = [{ byteLength: 1 }, { byteLength: 1 }, { byteLength: 1 }];
    expect(batchBySize(items, 1000, 2)).toEqual([[items[0], items[1]], [items[2]]]);
  });

  it('gives an over-cap item its own single-item batch rather than dropping it', () => {
    const items = [{ byteLength: 1 }, { byteLength: 999 }, { byteLength: 1 }];
    expect(batchBySize(items, 10, 8)).toEqual([[items[0]], [items[1]], [items[2]]]);
  });

  it('returns an empty array for no items', () => {
    expect(batchBySize([], 100, 8)).toEqual([]);
  });
});

describe('parseRevisionChain', () => {
  it('parses and sorts the bundled demo sample\'s three-entry chain', async () => {
    const samplePath = path.join(__dirname, '..', '..', 'public', 'assets', 'demo', 'pdf-seal-sample.pdf');
    const sampleBytes = fs.readFileSync(samplePath);
    const tool = await PdfSignatureTool.fromBytes(sampleBytes);
    const rawInfo = tool.getRawInfoDict();
    const raw = rawInfo['PdfSealRevisionChainV1'] || rawInfo['PdfSealRevisionChain'];

    const entries = parseRevisionChain(raw);
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.index)).toEqual([1, 2, 3]);
    entries.forEach((e) => expect(typeof e.bytes).toBe('string'));

    // Parity with the tool's own already-parsed accessor.
    expect(entries).toEqual(tool.getRevisionSnapshotChain());
  });

  it('sorts out-of-order entries', () => {
    const raw = JSON.stringify([{ index: 2, bytes: 'Yg==' }, { index: 1, bytes: 'YQ==' }]);
    expect(parseRevisionChain(raw)).toEqual([{ index: 1, bytes: 'YQ==' }, { index: 2, bytes: 'Yg==' }]);
  });

  it('returns an empty array for a single-entry chain (nothing worth hydrating)', () => {
    expect(parseRevisionChain(JSON.stringify([{ index: 1, bytes: 'YQ==' }]))).toEqual([]);
  });

  it('returns an empty array for absent, malformed, or non-array input', () => {
    expect(parseRevisionChain(null)).toEqual([]);
    expect(parseRevisionChain(undefined)).toEqual([]);
    expect(parseRevisionChain('')).toEqual([]);
    expect(parseRevisionChain('not json{')).toEqual([]);
    expect(parseRevisionChain('{"not":"an array"}')).toEqual([]);
  });

  it('drops malformed entries within an otherwise valid array', () => {
    const raw = JSON.stringify([{ index: 1, bytes: 'YQ==' }, { bytes: 42 }, null, { index: 2, bytes: 'Yg==' }]);
    expect(parseRevisionChain(raw)).toEqual([{ index: 1, bytes: 'YQ==' }, { index: 2, bytes: 'Yg==' }]);
  });
});
