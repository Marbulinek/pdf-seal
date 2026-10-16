import type { DocField, PdfRect } from './models';

/** Only signature fields can be created; every other field type is inspect-only. */
export const FIELD_TYPE_CONFIG = {
  signature: { defaultWidth: 200, defaultHeight: 60 },
} as const;

/**
 * The one rule for what the editor may move, resize or rename: an unsigned
 * signature field. Keep in sync with PdfSignatureTool._requireEditableField().
 */
export function isEditableField(f: DocField | null | undefined): boolean {
  return !!f && f.type === 'Signature' && f.signed !== true;
}

/** Position-only edits: any unsigned field (a signed one's /Rect is inside the signed bytes). */
export function isMovableField(f: DocField | null | undefined): boolean {
  return !!f && !!f.name && f.signed !== true;
}

/**
 * What the Edit sheet's Remove button may delete: any named field -- text
 * boxes, checkboxes and signed signatures too (the server removes by name).
 */
export function isRemovableField(f: DocField | null | undefined): boolean {
  return !!f && !!f.name;
}

/**
 * Some signature fields are authored with a near-zero /Rect (commonly 0x0,
 * tucked into a page corner) by tools that attach a signature without a
 * visible appearance. Callers give them a fixed-size marker instead of their
 * true (invisible) footprint. Checkboxes/radios and the Overview's
 * links/comments/stamps (a link around one line of small text is ~8pt tall)
 * are legitimately small, so for them only a truly ~zero-size rect counts.
 */
export const INVISIBLE_FIELD_MAX_DIMENSION = 10; // PDF points

const SMALL_BY_DESIGN = new Set(['CheckBox', 'RadioGroup', 'link', 'comment', 'stamp']);

export function isRectPracticallyInvisible(rect: PdfRect | null | undefined, type?: string): boolean {
  if (!rect) return false;
  const max = type && SMALL_BY_DESIGN.has(type) ? 2 : INVISIBLE_FIELD_MAX_DIMENSION;
  return rect.width < max || rect.height < max;
}

const FIELD_TYPE_ICONS: Record<string, string> = {
  CheckBox: 'icon-check-square',
  RadioGroup: 'icon-radio',
  Button: 'icon-button',
  Dropdown: 'icon-chevron-down',
  OptionList: 'icon-list',
};

/** Distinct icon class for non-text, non-signature widgets (null for everything else). */
export function choiceFieldIconClass(type: string | undefined): string | null {
  return (type && FIELD_TYPE_ICONS[type]) || null;
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
