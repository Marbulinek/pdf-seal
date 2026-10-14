import { coordsEqual, rectsEqual, sizeEqual } from '../../core/field-rules';
import type { DocField, FieldOp } from '../../core/models';

/**
 * Whether `field` differs from its last-applied server state -- new, or
 * moved/resized/toggled since. Drives the marching-ants outline on staged fields.
 */
export function isFieldStaged(field: DocField, baseline: readonly DocField[]): boolean {
  const base = baseline.find((f) => f.name === field.name);
  if (!base) return true;
  return !rectsEqual(base.rect, field.rect) || !!base.required !== !!field.required;
}

/**
 * Diffs the working fields against the server-confirmed baseline to produce
 * exactly the ops the server needs, in one pass. Fields carry a
 * `__baselineName` that stays fixed across a rename, so a renamed field is
 * reported as one 'edit' rather than a remove + add.
 */
export function computeFieldOps(fields: readonly DocField[], baseline: readonly DocField[]): FieldOp[] {
  const baselineByName = new Map(baseline.map((f) => [f.name, f]));
  const matchedBaselineNames = new Set<string>();
  const ops: FieldOp[] = [];

  for (const field of fields) {
    const baselineKey = field.__baselineName || field.name;
    const base = baselineByName.get(baselineKey);
    const rect = field.rect ?? { x: 0, y: 0, width: 0, height: 0 };
    if (!base) {
      ops.push({
        op: 'add',
        name: field.name,
        type: 'signature',
        page: field.page,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        required: !!field.required,
      });
      continue;
    }
    matchedBaselineNames.add(baselineKey);
    const renamed = field.name !== baselineKey;
    const positionChanged = !coordsEqual(base.rect, field.rect);
    const sizeChanged = !sizeEqual(base.rect, field.rect);
    const requiredChanged = !!base.required !== !!field.required;
    if (renamed || positionChanged || sizeChanged || requiredChanged) {
      ops.push({
        op: 'edit',
        originalName: baselineKey,
        name: field.name,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        required: !!field.required,
        // UI-only markers, stripped before the payload is sent (see serializeOps).
        _positionChanged: positionChanged,
        _sizeChanged: sizeChanged,
        _requiredChanged: requiredChanged,
      });
    }
  }

  for (const name of baselineByName.keys()) {
    if (!matchedBaselineNames.has(name)) ops.push({ op: 'remove', name });
  }
  return ops;
}

/** The request payload: the ops without their UI-only `_`-prefixed markers. */
export function serializeOps(ops: readonly FieldOp[]): string {
  return JSON.stringify(ops, (key, value: unknown) => (key.startsWith('_') ? undefined : value));
}

/**
 * A short recap like "Added 1 field, Renamed 1 field, Moved 2 fields" for
 * the unsaved-changes bar. Move and resize are counted independently.
 */
export function describePendingFieldChanges(ops: readonly FieldOp[]): string {
  const s = (n: number) => (n === 1 ? '' : 's');
  const added = ops.filter((op) => op.op === 'add').length;
  const editOps = ops.filter((op): op is Extract<FieldOp, { op: 'edit' }> => op.op === 'edit');
  const renamed = editOps.filter((op) => op.name !== op.originalName).length;
  const nonRenamedEdits = editOps.filter((op) => op.name === op.originalName);
  const moved = nonRenamedEdits.filter((op) => op._positionChanged).length;
  const resized = nonRenamedEdits.filter((op) => op._sizeChanged).length;
  const requiredChanged = nonRenamedEdits.filter((op) => op._requiredChanged).length;
  const removed = ops.filter((op) => op.op === 'remove').length;
  const parts: string[] = [];
  if (added) parts.push(`Added ${added} field${s(added)}`);
  if (renamed) parts.push(`Renamed ${renamed} field${s(renamed)}`);
  if (moved) parts.push(`Moved ${moved} field${s(moved)}`);
  if (resized) parts.push(`Resized ${resized} field${s(resized)}`);
  if (requiredChanged) parts.push(`Changed ${requiredChanged} field requirement${s(requiredChanged)}`);
  if (removed) parts.push(`Removed ${removed} field${s(removed)}`);
  return parts.join(', ');
}

export interface PendingChangeTag {
  cls: 'add' | 'remove' | 'rename' | 'move' | 'resize' | 'required';
  text: string;
}

export interface PendingChangeRow {
  name: string;
  fromName: string | null;
  tags: PendingChangeTag[];
}

/** Per-field breakdown for the "View changes" list. */
export function buildPendingChangesDetails(ops: readonly FieldOp[]): PendingChangeRow[] {
  return ops.map((op) => {
    const tags: PendingChangeTag[] = [];
    if (op.op === 'add') {
      tags.push({ cls: 'add', text: 'Added' });
    } else if (op.op === 'remove') {
      tags.push({ cls: 'remove', text: 'Removed' });
    } else {
      if (op.name !== op.originalName) tags.push({ cls: 'rename', text: 'Renamed' });
      if (op._positionChanged) tags.push({ cls: 'move', text: 'Moved' });
      if (op._sizeChanged) tags.push({ cls: 'resize', text: 'Resized' });
      if (op._requiredChanged) tags.push({ cls: 'required', text: 'Required' });
    }
    const fromName = op.op === 'edit' && op.name !== op.originalName ? op.originalName : null;
    return { name: op.name, fromName, tags };
  });
}
