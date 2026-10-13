import type { SaveKind, VersionSource } from '../../../../lib/VersionHistory';
import { isRectPracticallyInvisible } from '../../core/field-rules';
import type { DiffStampEntry, PdfRect, RawObjectPreview, RevisionDiff, RevisionSummary } from '../../core/models';
import { formatByteDelta } from '../../core/util/format';

/** One stored version as the timeline shows it: its meta plus (once fetched) its summary. */
export interface RevisionEntry extends Partial<RevisionSummary> {
  index: number;
  versionKey: string;
  byteLength: number;
  source: VersionSource;
  saveKind: SaveKind;
  loaded: boolean;
  isFinal: boolean;
  /** Set while a single card's lazy detail fetch runs / after it failed. */
  detailState?: 'loading' | string;
}

export type DiffTab = 'overview' | 'details' | 'visual';

export const TAG_LABEL_CLASS: Record<string, string> = {
  Original: 'tag-original',
  Imported: 'tag-imported',
  'Incremental update': 'tag-incremental',
  'Full rewrite': 'tag-rewrite',
  Current: 'tag-current',
  Signed: 'tag-signed',
  'Earlier signatures may not verify': 'tag-warning',
};

/** Tooltip on each badge -- the labels alone aren't self-explanatory. */
export const TAG_LABEL_DESCRIPTION: Record<string, string> = {
  Original: 'The very first upload of this document.',
  Imported: "Unpacked from this file's own embedded version history, not created in this browser.",
  'Incremental update': "This save was appended to the previous version's bytes -- earlier signatures stay intact.",
  'Full rewrite': 'This save regenerated the whole PDF from scratch, rather than appending to the previous version.',
  Current: 'The version currently open in the viewer.',
  Signed: 'This version contains at least one digital signature.',
  'Earlier signatures may not verify':
    'This save fully rewrote a version that had a signature on it -- that earlier signature may no longer validate against these bytes.',
};

export const CLASSIFICATION_BADGES: Record<string, { label: string; cls: string }> = {
  structural: { label: 'Structural', cls: 'badge-structural' },
  dictionary: { label: 'Dictionary', cls: 'badge-dictionary' },
  'content-stream': { label: 'Content stream', cls: 'badge-content' },
  'visual-content': { label: 'Visual/content', cls: 'badge-visual' },
  signing: { label: 'Signing', cls: 'badge-signing' },
};

export function revisionLabel(rev: { index: number }): string {
  return `Version ${rev.index}`;
}

export function isSigned(rev: { signatures?: unknown[] | null }): boolean {
  return !!(rev.signatures && rev.signatures.length);
}

export interface ChecklistItem {
  label: string;
  unchanged: boolean;
  detail: string;
  /** Where a click on a changed row goes; null for inert rows. */
  target: { tab: DiffTab; section?: string } | null;
}

/** The at-a-glance "what changed" rows of the Overview tab. */
export function checklistItems(diff: RevisionDiff): ChecklistItem[] {
  const c = diff.checklist;
  if (!c) return [];
  const visual = { tab: 'visual' as const };
  const item = (
    label: string,
    unchanged: boolean,
    count: number,
    noun: string,
    target: ChecklistItem['target'],
  ): ChecklistItem => ({
    label,
    unchanged,
    detail: unchanged ? 'Unchanged' : `${count} ${noun}`,
    target: unchanged ? null : target,
  });
  return [
    item('Pages', c.pagesUnchanged, c.pagesChangedCount, 'page(s) changed', visual),
    item('Text', c.textUnchanged, c.textChangedCount, 'content stream(s) changed', visual),
    item('Images', c.imagesUnchanged, c.imagesChangedCount, 'image(s) changed', visual),
    item('Signature fields', c.signatureFieldsUnchanged, c.signatureFieldsChangedCount, 'field(s) changed', { tab: 'details', section: 'fields' }),
    item('AcroForm', c.acroFormUnchanged, c.acroFormChangedCount, 'object(s) changed', { tab: 'details', section: 'objects' }),
    item('Stamps', c.stampsUnchanged, c.stampsChangedCount, 'stamp(s) changed', { tab: 'details', section: 'stamps' }),
    item('Metadata', c.metadataUnchanged, c.metadataChangedCount, 'value(s) changed', { tab: 'details', section: 'metadata' }),
    item('Signature', c.signatureUnchanged, c.signatureChangedCount, 'signature event(s)', { tab: 'details', section: 'signature' }),
  ];
}

/**
 * The sheet header's one-liner: a change count, the headline events, and the
 * size delta -- rather than repeating the pair of version labels.
 */
export function compareVerdict(diff: RevisionDiff): string {
  const c = diff.checklist;
  const counts = c
    ? [
        c.pagesChangedCount,
        c.textChangedCount,
        c.imagesChangedCount,
        c.signatureFieldsChangedCount,
        c.acroFormChangedCount,
        c.stampsChangedCount,
        c.metadataChangedCount,
        c.signatureChangedCount,
      ]
    : [];
  const total = counts.reduce((sum, n) => sum + (n || 0), 0);

  const headline: string[] = [];
  if (diff.signatureChanges?.added?.length) headline.push('signature applied');
  else if (diff.signatureChanges?.removed?.length) headline.push('signature removed');
  if (diff.fieldChanges?.added?.length) headline.push(`${diff.fieldChanges.added.length} field(s) added`);
  if (diff.fieldChanges?.removed?.length) headline.push(`${diff.fieldChanges.removed.length} field(s) removed`);
  if (diff.stampChanges?.added?.length) headline.push(`${diff.stampChanges.added.length} stamp(s) added`);
  if (diff.stampChanges?.removed?.length) headline.push(`${diff.stampChanges.removed.length} stamp(s) removed`);
  if (diff.pageCountDelta) headline.push(`${diff.pageCountDelta > 0 ? '+' : '−'}${Math.abs(diff.pageCountDelta)} page(s)`);

  const parts = [total === 0 ? 'No changes detected' : `${total} change${total === 1 ? '' : 's'}`];
  if (headline.length) parts.push(headline.join(' · '));
  parts.push(`${formatByteDelta(diff.byteLengthDelta)} file size`);
  return parts.join(' · ');
}

export function noPreviewReasonText(item: Pick<RawObjectPreview, 'page' | 'noPreviewReason'>): string {
  const page = Number.isInteger(item.page) ? (item.page as number) + 1 : null;
  switch (item.noPreviewReason) {
    case 'renders-identically':
      return 'The stream was re-written but decodes to identical content — the page renders exactly the same.';
    case 'document-level':
      return 'A document-level object. It has no place on any page; the change is in the PDF source below.';
    case 'no-geometry':
      return page
        ? `This object lives on page ${page} but has no rectangle or extractable position — see the PDF source below for what changed.`
        : 'This object has no rectangle or extractable position — see the PDF source below for what changed.';
    case 'page-unknown':
      return 'This object could not be matched to a specific page — see the PDF source below for what changed.';
    default:
      return 'PDF source change only — no visible page location is available for this raw object.';
  }
}

/**
 * Row locate keys are namespaced ("field-added:sig2") to stay unique; the
 * banner wants only the name. Raw-object keys ("6 0 R") pass through.
 */
export function diffPreviewLabel(key: string): string {
  const idx = key.indexOf(':');
  return idx === -1 ? key : key.slice(idx + 1);
}

/** A string-only raw entry (old server payloads) widened to a full preview. */
export function asRawPreview(entry: RawObjectPreview | string): RawObjectPreview {
  if (typeof entry !== 'string') return entry;
  return {
    key: entry,
    page: null,
    rects: [],
    hasVisualLocation: false,
    type: null,
    subtype: null,
    previewMode: 'none',
    noPreviewReason: null,
    category: null,
    fieldName: null,
    changesText: '',
    humanName: null,
    label: entry,
    dictionaryChanges: [],
    streamDiff: null,
    classifications: [],
    sourceBefore: null,
    sourceAfter: null,
    sourceTruncated: false,
  };
}

// ---------------------------------------------------------------------------
// Compare sheet -> Details tab view model
// ---------------------------------------------------------------------------

export interface DiffLocate {
  page: number;
  rect: PdfRect;
  side: 'from' | 'to';
  key: string;
}

export interface DiffValueChange {
  key: string;
  before: string;
  after: string;
}

export interface DiffRow {
  badge: 'added' | 'removed' | 'modified';
  badgeText: string;
  key: string;
  /** Plain text for added/removed rows. */
  text: string;
  /** "key: before → after" pairs for changed rows. */
  changes: DiffValueChange[];
  locate: DiffLocate | null;
}

export type DiffSectionKey = 'metadata' | 'fields' | 'stamps' | 'signature';

export interface DiffSection {
  key: DiffSectionKey;
  icon: string;
  title: string;
  rows: DiffRow[];
}

export type ChipClass = 'chip-added' | 'chip-removed' | 'chip-modified';

export interface ObjectChip {
  objectId: string;
  cls: ChipClass;
  item: RawObjectPreview;
  revisionIndex: number | null;
  canShowOnPage: boolean;
  showLabel: string;
  side: 'from' | 'to';
  filterTerm: string;
  invisible: boolean;
}

export interface ObjectChipGroup {
  label: string;
  cls: ChipClass;
  icon: string;
  chips: ObjectChip[];
}

const CHIP_ICONS: Record<ChipClass, string> = {
  'chip-added': 'icon-plus-bold',
  'chip-removed': 'icon-minus-bold',
  'chip-modified': 'icon-edit2',
};

function locateFor(page: number | null, rect: PdfRect | null, side: 'from' | 'to', key: string): DiffLocate | null {
  if (page === null || !Number.isInteger(page) || !rect || rect.width <= 0 || rect.height <= 0) return null;
  return { page, rect, side, key };
}

function valueChanges(changes: { key: string; before: unknown; after: unknown }[]): DiffValueChange[] {
  return changes.map((c) => ({ key: c.key, before: String(c.before), after: String(c.after) }));
}

function stampLabel(s: DiffStampEntry): string {
  return s.text || s.name || (s.kind === 'image' ? 'Image Stamp' : 'Stamp');
}

/** The Details tab's change lists: Metadata, Signature fields, Stamps, Signature. */
export function diffSections(diff: RevisionDiff): DiffSection[] {
  const row = (
    badge: DiffRow['badge'],
    badgeText: string,
    key: string,
    text: string,
    locate: DiffLocate | null,
    changes: DiffValueChange[] = [],
  ): DiffRow => ({ badge, badgeText, key, text, changes, locate });

  const metadata = diff.metadataChanges.map((c) =>
    row('modified', 'changed', c.key, '', null, [
      { key: '', before: c.before == null ? '(empty)' : String(c.before), after: c.after == null ? '(empty)' : String(c.after) },
    ]),
  );
  const fields = [
    ...diff.fieldChanges.added.map((f) => row('added', 'added', f.name, f.type || '', locateFor(f.page, f.rect, 'to', `field-added:${f.name}`))),
    ...diff.fieldChanges.removed.map((f) =>
      row('removed', 'removed', f.name, f.type || '', locateFor(f.page, f.rect, 'from', `field-removed:${f.name}`)),
    ),
    ...diff.fieldChanges.modified.map((f) =>
      row('modified', 'changed', f.name, '', locateFor(f.page, f.rect, 'to', `field-modified:${f.name}`), valueChanges(f.changes)),
    ),
  ];
  const stamps = [
    ...(diff.stampChanges?.added ?? []).map((s) =>
      row('added', 'added', stampLabel(s), s.kind || '', locateFor(s.page, s.rect, 'to', `stamp-added:${s.id}`)),
    ),
    ...(diff.stampChanges?.removed ?? []).map((s) =>
      row('removed', 'removed', stampLabel(s), s.kind || '', locateFor(s.page, s.rect, 'from', `stamp-removed:${s.id}`)),
    ),
    ...(diff.stampChanges?.modified ?? []).map((s) =>
      row('modified', 'changed', s.label || 'Stamp', '', locateFor(s.page, s.rect, 'to', `stamp-modified:${s.id}`), valueChanges(s.changes)),
    ),
  ];
  const signature = [
    ...diff.signatureChanges.added.map((s) =>
      row(
        'added',
        'signed',
        s.fieldName,
        [s.name, s.reason, s.signingTime].filter(Boolean).join(' · ') || 'Signature applied',
        locateFor(s.page, s.rect, 'to', `sig-added:${s.fieldName}`),
      ),
    ),
    ...diff.signatureChanges.removed.map((s) =>
      row('removed', 'removed', s.fieldName, 'Signature no longer present', locateFor(s.page, s.rect, 'from', `sig-removed:${s.fieldName}`)),
    ),
  ];
  return [
    { key: 'metadata', icon: 'icon-info-circle', title: 'Metadata', rows: metadata },
    { key: 'fields', icon: 'icon-pen', title: 'Signature fields', rows: fields },
    { key: 'stamps', icon: 'icon-stamp', title: 'Stamps', rows: stamps },
    { key: 'signature', icon: 'icon-lock', title: 'Signature', rows: signature },
  ];
}

/** A bare object ref (older payloads) promoted to a preview with nothing to show. */
export function bareRawObject(key: string): RawObjectPreview {
  return {
    key,
    page: null,
    rects: [],
    type: null,
    subtype: null,
    previewMode: 'none',
    hasVisualLocation: false,
    noPreviewReason: null,
    category: null,
    fieldName: null,
    changesText: '',
    humanName: null,
    label: key,
    dictionaryChanges: [],
    streamDiff: null,
    classifications: [],
    sourceBefore: null,
    sourceAfter: null,
    sourceTruncated: false,
  };
}

function chipFor(item: RawObjectPreview, cls: ChipClass, revisionIndex: number | null): ObjectChip {
  const canShowOnPage = item.previewMode !== 'none';
  const pageLabel = item.page !== null && Number.isInteger(item.page) ? item.page + 1 : '?';
  return {
    objectId: `${cls}:${item.key}`,
    cls,
    item,
    revisionIndex,
    canShowOnPage,
    showLabel: item.previewMode === 'visual-page' ? `Show page ${pageLabel} changes` : `Show on page ${pageLabel}`,
    side: cls === 'chip-removed' ? 'from' : 'to',
    filterTerm: `${item.key} ${item.humanName || ''} ${item.fieldName || ''}`.toLowerCase(),
    invisible: item.rects.length > 0 && item.rects.every((r) => isRectPracticallyInvisible(r)),
  };
}

/** The "Raw PDF objects" chip groups (empty groups dropped). */
export function objectChipGroups(diff: RevisionDiff, fromRev: number | null, toRev: number | null): ObjectChipGroup[] {
  const o = diff.objectChanges;
  const group = (label: string, cls: ChipClass, details: RawObjectPreview[] | undefined, keys: string[], rev: number | null) => ({
    label,
    cls,
    icon: CHIP_ICONS[cls],
    chips: (details ?? keys.map(bareRawObject)).map((item) => chipFor(item, cls, rev)),
  });
  return [
    group('Added objects', 'chip-added', o.addedDetails, o.added, toRev),
    group('Removed objects', 'chip-removed', o.removedDetails, o.removed, fromRev),
    group('Modified objects', 'chip-modified', o.modifiedDetails, o.modified, toRev),
  ].filter((g) => g.chips.length > 0);
}

export function objectChangeCount(diff: RevisionDiff): number {
  return diff.objectChanges.added.length + diff.objectChanges.removed.length + diff.objectChanges.modified.length;
}

export function rawObjectCategories(groups: ObjectChipGroup[]): string[] {
  const set = new Set<string>();
  for (const g of groups) for (const c of g.chips) if (c.item.category) set.add(c.item.category);
  return [...set].sort();
}

export function chipMatchesFilter(chip: ObjectChip, filter: { term: string; categories: string[]; locatableOnly: boolean }): boolean {
  const term = filter.term.trim().toLowerCase();
  if (term && !chip.filterTerm.includes(term)) return false;
  if (filter.categories.length && !filter.categories.includes(chip.item.category || '')) return false;
  if (filter.locatableOnly && !chip.canShowOnPage) return false;
  return true;
}
