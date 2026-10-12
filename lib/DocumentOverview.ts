// Pure logic behind the Overview panel: curating raw PDF dictionary entries
// into readable "Technical details" rows, flattening fields/stamps/annotations
// into the one list that drives both the panel and the PDF hotspots, and
// picking the "at a glance" chips.
//
// public/index.html inlines this same logic (no frontend build step), so this
// module exists to give it unit coverage; keep the two in sync by hand.
// Everything here is pure: no DOM, no fetch.

export type OverviewKind = 'signature' | 'stamp' | 'field' | 'link' | 'comment';

export interface RectLike {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CuratedEntry {
  key: string;
  label: string;
  value: string;
}

export interface OverviewItem {
  kind: OverviewKind;
  key: string;
  label: string;
  page: number;
  rect: RectLike | null;
  status: string;
  // The field/stamp/annotation this row was built from.
  source: any;
}

export interface GlanceChip {
  id: string;
  label: string;
  tone: 'neutral' | 'positive' | 'warning';
  // 'revisions' => the chip links to the Versions panel.
  goto?: string;
  // Tooltip text.
  title?: string;
}

const CERTIFICATION_CHIPS: Record<number, { label: string; tone: GlanceChip['tone']; title: string }> = {
  1: {
    label: 'Certified · no changes allowed',
    tone: 'warning',
    title: 'This document is certified with no changes allowed. Adding a field will invalidate its certification.',
  },
  2: {
    label: 'Certified · form filling & signing allowed',
    tone: 'neutral',
    title: 'The certifier permits form filling and signing only. Other changes invalidate the certification.',
  },
  3: {
    label: 'Certified · filling, signing & comments allowed',
    tone: 'neutral',
    title: 'The certifier permits form filling, signing and annotations. Other changes invalidate the certification.',
  },
};

const KEY_LABELS: Record<string, string> = {
  T: 'Name',
  TU: 'Tooltip',
  FT: 'Field type',
  V: 'Value',
  DV: 'Default value',
  DA: 'Default appearance',
  F: 'Flags',
  Ff: 'Field flags',
  Rect: 'Position',
  Subtype: 'Subtype',
  Contents: 'Text',
  NM: 'Identifier',
  M: 'Modified',
  CA: 'Opacity',
  AS: 'Appearance state',
  Name: 'Icon name',
  ByteRange: 'Signed byte ranges',
  Reason: 'Reason',
  Location: 'Location',
  Filter: 'Filter',
  SubFilter: 'Sub-filter',
  Q: 'Alignment',
  MaxLen: 'Max length',
  Opt: 'Options',
};

// Structural noise that means nothing to a reader.
const HIDDEN_KEYS = new Set(['Type', 'P', 'Parent', 'AP', 'Kids', 'Popup', 'Border', 'BS', 'MK', 'DR']);

const ANNOT_FLAGS: Array<[number, string]> = [
  [1, 'Invisible'], [2, 'Hidden'], [4, 'Print'], [8, 'NoZoom'], [16, 'NoRotate'],
  [32, 'NoView'], [64, 'ReadOnly'], [128, 'Locked'], [256, 'ToggleNoView'], [512, 'LockedContents'],
];

const FIELD_FLAGS: Array<[number, string]> = [
  [1, 'ReadOnly'], [2, 'Required'], [4, 'NoExport'],
  [1 << 12, 'Multiline'], [1 << 13, 'Password'], [1 << 20, 'FileSelect'], [1 << 22, 'DoNotSpellCheck'], [1 << 23, 'DoNotScroll'],
  [1 << 24, 'Comb'], [1 << 25, 'RichText'],
];

const MAX_STRING = 200;

function flagNames(n: number, table: Array<[number, string]>): string {
  const names = table.filter(([bit]) => (n & bit) !== 0).map(([, name]) => name);
  return names.length ? names.join(', ') : 'None';
}

const round = (n: number) => Math.round(n * 10) / 10;

function numbersOf(text: string): number[] | null {
  const m = /^\[\s*([-+\d.\s]*)\]$/.exec(text.trim());
  if (!m) return null;
  const parts = m[1].trim().split(/\s+/).filter(Boolean);
  const nums = parts.map(Number);
  return nums.some((n) => Number.isNaN(n)) ? null : nums;
}

function curateValue(key: string, value: string): string {
  const text = String(value ?? '');
  const n = Number(text);

  if (key === 'F' && text.trim() !== '' && Number.isInteger(n)) return flagNames(n, ANNOT_FLAGS);
  if (key === 'Ff' && text.trim() !== '' && Number.isInteger(n)) return flagNames(n, FIELD_FLAGS);

  const nums = numbersOf(text);
  if (key === 'Rect' && nums && nums.length === 4) {
    const [x1, y1, x2, y2] = nums;
    return `${round(Math.min(x1, x2))}, ${round(Math.min(y1, y2))} · ${round(Math.abs(x2 - x1))} × ${round(Math.abs(y2 - y1))} pt`;
  }
  if (key === 'ByteRange' && nums && nums.length === 4) {
    const [, a, b, len] = nums;
    return `bytes 0–${a} and ${b}–${b + len}`;
  }
  if (nums && nums.length > 8) return `${nums.length} numbers`;

  const hex = /^<([0-9a-fA-F\s]+)>$/.exec(text);
  const hexDigits = hex ? hex[1].replace(/\s/g, '').length : 0;
  if (hex && hexDigits > 64) return `binary data, ${Math.ceil(hexDigits / 2)} bytes`;
  // eslint-disable-next-line no-control-regex
  if (text.length > 64 && /[\x00-\x08\x0e-\x1f]/.test(text)) return `binary data, ${text.length} bytes`;

  if (text.length > MAX_STRING) return `${text.slice(0, MAX_STRING)}… (${text.length} chars)`;
  return text;
}

/** Turn a raw dictionary-entries record into readable rows for a "Technical details" disclosure. */
export function curateRawEntries(raw: Record<string, string> | null | undefined, _kind?: OverviewKind | string): CuratedEntry[] {
  if (!raw) return [];
  return Object.entries(raw)
    .filter(([key]) => !HIDDEN_KEYS.has(key))
    .map(([key, value]) => ({ key, label: KEY_LABELS[key] || key, value: curateValue(key, value) }));
}

// Same wording as the panel's fieldStateLabel() in public/index.html.
export function fieldStateLabel(field: any): string {
  const raw = field.raw || {};
  if (field.type === 'Signature') return raw.V ? 'Signed' : 'Empty';
  if (field.type === 'CheckBox' || field.type === 'RadioGroup') {
    const state = raw.AS || raw.V || '';
    return state && state !== '/Off' && state !== 'Off' ? 'Checked' : 'Unchecked';
  }
  return raw.V ? 'Filled' : 'Empty';
}

function stampLabel(s: any): string {
  return s.text || s.note || s.name || (s.kind === 'image' ? 'Image stamp' : 'Stamp');
}

function annotLabel(a: any, kind: OverviewKind): string {
  if (kind === 'link') return a.uri || (Number.isInteger(a.destPage) ? `Go to page ${a.destPage + 1}` : 'Link');
  const text = (a.contents || '').trim();
  const name = a.subtype === 'Text' ? 'Note' : a.subtype === 'FreeText' ? 'Text box' : a.subtype;
  return text ? `${name}: ${text.length > 60 ? `${text.slice(0, 60)}…` : text}` : name;
}

/** Flatten fields, stamps and annotations into one list, in reading order (page, then top to bottom). */
export function overviewItems(input: { fields?: any[]; stamps?: any[]; annotations?: any[] }): OverviewItem[] {
  const items: OverviewItem[] = [];
  (input.fields || []).forEach((f) => {
    items.push({
      kind: f.type === 'Signature' ? 'signature' : 'field',
      key: f.name,
      label: f.name || '—',
      page: f.page ?? 0,
      rect: f.rect || null,
      status: fieldStateLabel(f),
      source: f,
    });
  });
  (input.stamps || []).forEach((s) => {
    items.push({
      kind: 'stamp',
      key: s.id || s.ref || '',
      label: stampLabel(s),
      page: s.page ?? 0,
      rect: s.rect || null,
      status: s.kind === 'image' ? 'Image' : s.kind === 'text' ? 'Text' : 'Stamp',
      source: s,
    });
  });
  (input.annotations || []).forEach((a) => {
    const kind: OverviewKind = a.kind === 'link' ? 'link' : 'comment';
    items.push({
      kind,
      key: a.ref || '',
      label: annotLabel(a, kind),
      page: a.page ?? 0,
      rect: a.rect || null,
      status: kind === 'link' ? (a.uri ? 'URL' : Number.isInteger(a.destPage) ? `Page ${a.destPage + 1}` : 'Link') : a.subtype,
      source: a,
    });
  });
  // PDF y grows upward, so the top edge is y + height.
  const top = (i: OverviewItem) => (i.rect ? i.rect.y + i.rect.height : -Infinity);
  return items.sort((a, b) => a.page - b.page || top(b) - top(a));
}

/** Only the chips that are true or non-zero. `overview` is /api/info's `overview`. */
export function atAGlanceChips(overview: any, fields?: any[]): GlanceChip[] {
  const out: GlanceChip[] = [];
  const features = (overview && overview.features) || {};
  const signed = features.signatureCount || 0;
  if (signed > 0) out.push({ id: 'signed', label: signed === 1 ? 'Signed' : `Signed ×${signed}`, tone: 'positive' });
  const cert = CERTIFICATION_CHIPS[features.certification];
  if (cert) out.push({ id: 'certified', ...cert });
  const toFill = (fields || []).filter((f) => {
    if (f.readOnly) return false;
    return fieldStateLabel(f) === 'Empty' || fieldStateLabel(f) === 'Unchecked';
  }).length;
  if (toFill > 0) out.push({ id: 'toFill', label: `${toFill} field${toFill === 1 ? '' : 's'} to fill`, tone: 'neutral' });
  if (features.encrypted) out.push({ id: 'encrypted', label: 'Encrypted', tone: 'neutral' });
  if (features.pdfA === 'Yes') out.push({ id: 'pdfa', label: 'PDF/A', tone: 'neutral' });
  if (features.javascript) out.push({ id: 'js', label: 'Contains JavaScript', tone: 'warning' });
  if (features.attachmentCount > 0) {
    out.push({ id: 'attachments', label: `${features.attachmentCount} attachment${features.attachmentCount === 1 ? '' : 's'}`, tone: 'neutral' });
  }
  // One boundary is just a normal xref table, not an update (same threshold as the old Features card).
  if (features.incrementalUpdates > 1) {
    out.push({ id: 'updates', label: `${features.incrementalUpdates} updates`, tone: 'neutral', goto: 'revisions' });
  }
  return out;
}
