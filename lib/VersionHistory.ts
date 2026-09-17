// Pure logic behind the Revisions panel's "Versions" view -- classifying how
// each locally-stored snapshot was produced (an appended incremental update
// vs. a full rewrite) and turning that into the badges/filter the UI shows.
//
// public/index.html inlines this same classify/badge/filter logic directly
// (the app has no frontend build step to import from here), so this module
// exists to give it unit coverage; keep the two in sync by hand if either
// changes. Everything here is pure: no IndexedDB, no DOM.

export type SaveKind = 'initial' | 'identical' | 'incremental' | 'rewrite';
export type VersionSource = 'upload' | 'imported' | 'edit';

export interface SignatureLike {
  [key: string]: unknown;
}

export interface VersionEntryLike {
  index: number;
  source?: VersionSource;
  saveKind?: SaveKind;
  signatures?: SignatureLike[];
}

export type BadgeTone = 'neutral' | 'positive' | 'warning' | 'info';

export interface VersionBadge {
  label: string;
  tone: BadgeTone;
}

export type VersionGroupKind = 'incremental' | 'full';

export interface VersionGroupDivider {
  // Index into the entries array passed in: the divider belongs immediately
  // above entries[position].
  position: number;
  kind: VersionGroupKind;
  label: string;
  // How many consecutive entries the run below this divider contains.
  runLength: number;
}

// True when `a` and `b` are byte-identical. Length is checked first so the
// common case (a genuinely different save) short-circuits without walking
// the whole buffer.
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// Classifies how `currBytes` relates to the previous save (`prevBytes`, or
// null for the very first save of a document).
//
// - No previous bytes at all -> 'initial'.
// - Byte-identical to the previous save -> 'identical' (a save that changed
//   nothing effective, e.g. an edit that round-tripped back to the same
//   output).
// - `currBytes` is longer than `prevBytes` and starts with every byte of
//   `prevBytes` -> 'incremental'. This is what a real PDF incremental update
//   looks like (the whole prior file plus an appended update section), and
//   it's also what the server's native-boundary fallback chain and the
//   bundled demo's revision 3 produce.
// - Anything else -> 'rewrite' (the file was regenerated from scratch, even
//   if it happens to be longer).
export function classifySave(prevBytes: Uint8Array | null, currBytes: Uint8Array): SaveKind {
  if (!prevBytes) return 'initial';
  if (bytesEqual(prevBytes, currBytes)) return 'identical';
  if (currBytes.length > prevBytes.length) {
    let isPrefix = true;
    for (let i = 0; i < prevBytes.length; i++) {
      if (prevBytes[i] !== currBytes[i]) {
        isPrefix = false;
        break;
      }
    }
    if (isPrefix) return 'incremental';
  }
  return 'rewrite';
}

const SAVE_KIND_BADGE: Record<Exclude<SaveKind, 'identical'>, VersionBadge | null> = {
  initial: null,
  incremental: { label: 'Incremental update', tone: 'positive' },
  rewrite: { label: 'Full rewrite', tone: 'neutral' },
};

// Builds the ordered list of badges shown on one timeline entry. `prevEntry`
// is the entry immediately before `entry` in the (unfiltered) timeline, or
// undefined for the first one -- used only for the "earlier signatures may
// not verify" warning, which depends on what the previous entry had signed.
export function versionBadges(
  entry: VersionEntryLike,
  prevEntry: VersionEntryLike | undefined,
  isLast: boolean,
): VersionBadge[] {
  const badges: VersionBadge[] = [];

  if (entry.index === 1 && entry.source === 'upload') {
    badges.push({ label: 'Original', tone: 'neutral' });
  }
  if (entry.source === 'imported') {
    badges.push({ label: 'Imported', tone: 'neutral' });
  }

  const kindBadge = entry.saveKind && entry.saveKind !== 'identical' ? SAVE_KIND_BADGE[entry.saveKind] : null;
  if (kindBadge) badges.push(kindBadge);

  if (isLast) {
    badges.push({ label: 'Current', tone: 'info' });
  }

  if (Array.isArray(entry.signatures) && entry.signatures.length > 0) {
    badges.push({ label: 'Signed', tone: 'positive' });
  }

  if (entry.saveKind === 'rewrite' && prevEntry && Array.isArray(prevEntry.signatures) && prevEntry.signatures.length > 0) {
    badges.push({ label: 'Earlier signatures may not verify', tone: 'warning' });
  }

  return badges;
}

// Keeps only entries whose save was an incremental update, plus the base
// entry (index 1) so the timeline never loses its starting point. Returns
// `entries` unchanged (same array reference) when `onlyIncremental` is
// false, since the caller can then skip a re-render.
export function filterVersions<T extends VersionEntryLike>(entries: T[], onlyIncremental: boolean): T[] {
  if (!onlyIncremental) return entries;
  if (!Array.isArray(entries)) return entries;
  return entries.filter((entry) => entry.index === 1 || entry.saveKind === 'incremental');
}

// Which group a save belongs to for timeline-grouping purposes. 'initial' is
// folded in with 'rewrite' because the very first save is a whole file too --
// version 1 shouldn't open a group that version 2 immediately closes. Saves
// that changed nothing ('identical') and entries stored before saveKind
// existed (undefined) are transparent: they inherit whatever group is already
// open rather than manufacturing a divider of their own.
function groupKindOf(entry: VersionEntryLike): VersionGroupKind | null {
  if (entry.saveKind === 'incremental') return 'incremental';
  if (entry.saveKind === 'rewrite' || entry.saveKind === 'initial') return 'full';
  return null;
}

// Label wording is taken from SAVE_KIND_BADGE so a divider can never disagree
// with the tags on the cards beneath it; only the plural differs.
function groupLabel(kind: VersionGroupKind, runLength: number): string {
  const base = kind === 'incremental' ? SAVE_KIND_BADGE.incremental!.label : SAVE_KIND_BADGE.rewrite!.label;
  return runLength > 1 ? `${base}s` : base;
}

// Splits a timeline into runs of like saves and returns one divider per
// boundary between them, so the list can be read as groups ("these two were
// full rewrites, everything below is appended incremental updates") instead of
// a flat run of cards. A timeline that never changes kind -- the common case --
// yields no dividers at all.
//
// Positions index into `entries` as passed, so callers rendering a filtered
// list should pass that same filtered list.
export function versionGroupDividers(entries: VersionEntryLike[]): VersionGroupDivider[] {
  if (!Array.isArray(entries)) return [];

  const dividers: VersionGroupDivider[] = [];
  let openKind: VersionGroupKind | null = null;
  // Index into `dividers` of the divider whose runLength is still being
  // counted, or -1 while the first (never-divided) run is open.
  let pending = -1;

  for (let i = 0; i < entries.length; i++) {
    const kind = groupKindOf(entries[i]);

    if (kind && openKind && kind !== openKind) {
      dividers.push({ position: i, kind, label: '', runLength: 0 });
      pending = dividers.length - 1;
      openKind = kind;
    } else if (kind && !openKind) {
      openKind = kind;
    }

    if (pending >= 0) dividers[pending].runLength++;
  }

  for (const divider of dividers) {
    divider.label = groupLabel(divider.kind, divider.runLength);
  }

  return dividers;
}

export default {
  bytesEqual,
  classifySave,
  versionBadges,
  filterVersions,
  versionGroupDividers,
};
