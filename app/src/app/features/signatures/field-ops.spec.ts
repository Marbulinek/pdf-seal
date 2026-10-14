import type { DocField } from '../../core/models';
import { buildPendingChangesDetails, computeFieldOps, describePendingFieldChanges, isFieldStaged, serializeOps } from './field-ops';

const sig = (name: string, x = 10, y = 10, width = 200, height = 60, patch: Partial<DocField> = {}): DocField => ({
  name,
  type: 'Signature',
  page: 0,
  required: false,
  rect: { x, y, width, height },
  ...patch,
});

describe('field ops', () => {
  const baseline = [sig('A'), sig('B'), sig('C')];

  it('reports nothing when the fields match the baseline', () => {
    expect(computeFieldOps(baseline, baseline)).toEqual([]);
  });

  it('diffs adds, moves, resizes, renames, requirement changes and removals', () => {
    const fields = [
      sig('A', 50, 10), // moved
      sig('B2', 10, 10, 200, 60, { __baselineName: 'B', required: true }), // renamed + required
      sig('D'), // added
    ];
    const ops = computeFieldOps(fields, baseline);
    expect(ops.map((o) => o.op)).toEqual(['edit', 'edit', 'add', 'remove']);
    expect(describePendingFieldChanges(ops)).toBe('Added 1 field, Renamed 1 field, Moved 1 field, Removed 1 field');

    const rows = buildPendingChangesDetails(ops);
    expect(rows[1]).toEqual({
      name: 'B2',
      fromName: 'B',
      tags: [
        { cls: 'rename', text: 'Renamed' },
        { cls: 'required', text: 'Required' },
      ],
    });
    expect(rows[3].tags).toEqual([{ cls: 'remove', text: 'Removed' }]);
  });

  it('counts a pure resize separately from a move', () => {
    const ops = computeFieldOps([sig('A', 10, 10, 300, 60), sig('B'), sig('C')], baseline);
    expect(describePendingFieldChanges(ops)).toBe('Resized 1 field');
  });

  it('strips UI-only markers from the request payload', () => {
    const ops = computeFieldOps([sig('A', 99, 10), sig('B'), sig('C')], baseline);
    const payload = JSON.parse(serializeOps(ops));
    expect(Object.keys(payload[0]).some((k) => k.startsWith('_'))).toBe(false);
    expect(payload[0]).toMatchObject({ op: 'edit', originalName: 'A', x: 99 });
  });

  it('marks new and changed fields as staged', () => {
    expect(isFieldStaged(sig('Z'), baseline)).toBe(true);
    expect(isFieldStaged(sig('A'), baseline)).toBe(false);
    expect(isFieldStaged(sig('A', 10, 10, 200, 60, { required: true }), baseline)).toBe(true);
  });
});
