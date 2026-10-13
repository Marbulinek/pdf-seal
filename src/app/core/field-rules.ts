import type { DocField, PdfRect } from './models';

/** Only signature fields can be created; every other field type is inspect-only. */
export const FIELD_TYPE_CONFIG = {
  signature: { defaultWidth: 200, defaultHeight: 60 },
} as const;

/**
 * The one rule for what the editor may move, resize, rename or delete: an
 * unsigned signature field. Keep in sync with PdfSignatureTool._requireEditableField().
 */
export function isEditableField(f: DocField | null | undefined): boolean {
  return !!f && f.type === 'Signature' && f.signed !== true;
}

/**
 * Some signature fields are authored with a near-zero /Rect (commonly 0x0,
 * tucked into a page corner) by tools that attach a signature without a
 * visible appearance. Callers give them a fixed-size marker instead of their
 * true (invisible) footprint. Checkboxes/radios are legitimately small, so for
 * them only a truly ~zero-size rect counts as invisible.
 */
export const INVISIBLE_FIELD_MAX_DIMENSION = 10; // PDF points
export const SMALL_FIELD_NO_DELETE_HANDLE = 20; // PDF points

export function isRectPracticallyInvisible(rect: PdfRect | null | undefined, type?: string): boolean {
  if (!rect) return false;
  const max = type === 'CheckBox' || type === 'RadioGroup' ? 2 : INVISIBLE_FIELD_MAX_DIMENSION;
  return rect.width < max || rect.height < max;
}

/** Distinct icon class for checkbox/radio widgets (null for everything else). */
export function choiceFieldIconClass(type: string | undefined): string | null {
  return type === 'CheckBox' ? 'icon-check-square' : type === 'RadioGroup' ? 'icon-radio' : null;
}

const EPS = 0.01;

// Position (x/y) and size (width/height) are tracked separately so a pure
// resize isn't misreported as a "moved" field (and vice versa).
export function coordsEqual(a: PdfRect | null, b: PdfRect | null): boolean {
  if (!a || !b) return a === b;
  return Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS;
}

export function sizeEqual(a: PdfRect | null, b: PdfRect | null): boolean {
  if (!a || !b) return a === b;
  return Math.abs(a.width - b.width) < EPS && Math.abs(a.height - b.height) < EPS;
}

export function rectsEqual(a: PdfRect | null, b: PdfRect | null): boolean {
  if (!a || !b) return a === b;
  return coordsEqual(a, b) && sizeEqual(a, b);
}
