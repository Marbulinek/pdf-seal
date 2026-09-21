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

// ---------------------------------------------------------------------
// v2 storage helpers (IndexedDB `pdfseal-versions`, full copies + deltas,
// streamed hydration). Still pure -- no IndexedDB, no DOM, no pdf.js -- so
// the actual storage/network code just calls these to decide what to do.
// ---------------------------------------------------------------------

// Bytes this scanner treats as whitespace between "startxref" and the
// offset, and between the offset and "%%EOF": the five ASCII whitespace
// characters ISO 32000-1 recognizes, plus 0xA0 (non-breaking space) -- some
// encoders/mangled PDFs leave one there, and a JS regex's `\s` over a
// latin1-decoded string (see PdfRevisionTool.findRevisionBoundaries) already
// treats   as whitespace, so a raw byte scan has to match that by hand.
const REVISION_BOUNDARY_WS_BYTES = new Set([0x09, 0x0a, 0x0c, 0x0d, 0x20, 0xa0]);

function isRevisionBoundaryWhitespace(byte: number): boolean {
  return REVISION_BOUNDARY_WS_BYTES.has(byte);
}

function bytesMatchAt(bytes: Uint8Array, pos: number, pattern: number[]): boolean {
  if (pos + pattern.length > bytes.length) return false;
  for (let i = 0; i < pattern.length; i++) {
    if (bytes[pos + i] !== pattern[i]) return false;
  }
  return true;
}

const STARTXREF_BYTES = Array.from('startxref').map((c) => c.charCodeAt(0));
const EOF_MARKER_BYTES = Array.from('%%EOF').map((c) => c.charCodeAt(0));

// Byte-level equivalent of PdfRevisionTool's `/startxref\s+\d+\s*%%EOF/g`
// (see its REVISION_BOUNDARY_PATTERN) -- scans raw bytes directly instead of
// decoding to a string first, so it can run client-side against a Blob's
// bytes without pulling in Buffer. Returns each match's end offset
// (exclusive, i.e. one past "%%EOF") in the order found, oldest first --
// truncating `bytes` at any one of these yields a complete, independently
// valid PDF snapshot as it existed at that point.
export function findRevisionEndOffsets(bytes: Uint8Array): number[] {
  const offsets: number[] = [];

  for (let i = 0; i + STARTXREF_BYTES.length <= bytes.length; i++) {
    if (!bytesMatchAt(bytes, i, STARTXREF_BYTES)) continue;

    let pos = i + STARTXREF_BYTES.length;
    const wsStart = pos;
    while (pos < bytes.length && isRevisionBoundaryWhitespace(bytes[pos])) pos++;
    if (pos === wsStart) continue; // \s+ needs at least one

    const digitsStart = pos;
    while (pos < bytes.length && bytes[pos] >= 0x30 && bytes[pos] <= 0x39) pos++;
    if (pos === digitsStart) continue; // \d+ needs at least one
    let xrefOffset = 0;
    for (let d = digitsStart; d < pos; d++) xrefOffset = xrefOffset * 10 + (bytes[d] - 0x30);

    while (pos < bytes.length && isRevisionBoundaryWhitespace(bytes[pos])) pos++; // \s*

    if (!bytesMatchAt(bytes, pos, EOF_MARKER_BYTES)) continue;
    if (xrefOffset === 0) continue; // linearization first-page trailer, not a real revision
    offsets.push(pos + EOF_MARKER_BYTES.length);
  }

  return offsets;
}

// classifySave's counterpart for a previous version that lives in storage as
// a Blob rather than an already-in-memory Uint8Array -- reads it in chunks
// (default 1 MiB) instead of pulling the whole thing into memory up front.
//
// A length check alone decides 'rewrite' when the new file is shorter (no
// bytes need reading at all). Otherwise, chunks are compared starting from
// the head: the common case -- a genuine rewrite -- diverges immediately, so
// most calls never read past the first chunk; only a true prefix match
// streams all the way through to confirm 'identical' vs 'incremental'.
export async function classifySaveAgainstBlob(
  prevBlob: Blob | null,
  currBytes: Uint8Array,
  chunkSize = 1024 * 1024,
): Promise<SaveKind> {
  if (!prevBlob) return 'initial';
  if (currBytes.length < prevBlob.size) return 'rewrite';

  let offset = 0;
  while (offset < prevBlob.size) {
    const end = Math.min(offset + chunkSize, prevBlob.size);
    const prevChunk = new Uint8Array(await prevBlob.slice(offset, end).arrayBuffer());
    const currChunk = currBytes.subarray(offset, end);
    if (!bytesEqual(prevChunk, currChunk)) return 'rewrite';
    offset = end;
  }

  return currBytes.length === prevBlob.size ? 'identical' : 'incremental';
}

export interface PriorVersionRef {
  versionKey: string;
  byteLength: number;
}

export interface VersionStoragePlan {
  storage: 'full' | 'delta';
  baseKey: string | null;
  data: Uint8Array;
}

// Decides how to store one save: as a delta (just the appended bytes, plus
// which prior version they extend) when possible, otherwise the full file.
// Delta storage only makes sense for a save actually classified
// 'incremental' (its bytes are a genuine prefix-extension of the previous
// save -- a 'rewrite's bytes aren't, so slicing them at prevByteLength would
// produce garbage, not a valid delta), and only when `prev` -- the prior
// version's own known storage key and length -- is actually available. A
// null `prev` (the prior write's own storage isn't confirmed yet, or this is
// the first version) always falls back to a full copy.
export function planVersionStorage(prev: PriorVersionRef | null, saveKind: SaveKind, bytes: Uint8Array): VersionStoragePlan {
  if (saveKind === 'incremental' && prev && prev.byteLength <= bytes.length) {
    return { storage: 'delta', baseKey: prev.versionKey, data: bytes.slice(prev.byteLength) };
  }
  return { storage: 'full', baseKey: null, data: bytes };
}

export interface VersionMetaLike {
  index: number;
  versionKey: string;
  storage: 'full' | 'delta';
  baseKey: string | null;
}

// Which stored rows must be fetched (and concatenated, base first) to
// reconstruct the version at `index` -- walking backward through delta rows
// until a full row is found. Every delta's base is always the row
// immediately before it (see planVersionStorage) -- if a baseKey doesn't
// match that row's own versionKey, the chain has been broken (a row went
// missing, or storage was corrupted) and reading past it would silently
// assemble the wrong bytes, so this throws instead of guessing.
export function versionReadPlan(metas: VersionMetaLike[], index: number): VersionMetaLike[] {
  const byIndex = new Map(metas.map((meta) => [meta.index, meta]));
  const target = byIndex.get(index);
  if (!target) throw new Error(`Version ${index} is not available locally.`);

  const chain: VersionMetaLike[] = [target];
  let current = target;
  while (current.storage === 'delta') {
    const base = byIndex.get(current.index - 1);
    if (!base || base.versionKey !== current.baseKey) {
      throw new Error(`Version ${index} is not available locally.`);
    }
    chain.push(base);
    current = base;
  }

  return chain.reverse();
}

export interface SizedItem {
  byteLength: number;
}

// Splits `items` into sequential batches, each capped at `maxBytes` total
// and `maxCount` items -- whichever limit a batch hits first ends it. An
// item larger than maxBytes on its own still gets a (single-item) batch
// rather than being dropped or splitting the item itself.
export function batchBySize<T extends SizedItem>(items: T[], maxBytes: number, maxCount: number): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let currentBytes = 0;

  for (const item of items) {
    const wouldOverflow = current.length > 0 && (current.length >= maxCount || currentBytes + item.byteLength > maxBytes);
    if (wouldOverflow) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(item);
    currentBytes += item.byteLength;
  }
  if (current.length) batches.push(current);

  return batches;
}

export interface RevisionChainEntry {
  index: number;
  bytes: string; // base64
}

// Parses this app's own bundled revision-chain format -- the raw JSON string
// stored under the PdfSealRevisionChainV1/PdfSealRevisionChain custom Info
// key, see PdfSignatureTool.setRevisionSnapshotChain -- into entries sorted
// oldest-first. Anything that isn't a usable chain (absent, malformed JSON,
// not an array, or fewer than 2 entries -- one entry alone is just the
// current file and isn't worth a hydration pass) returns an empty array
// rather than throwing: an absent/garbled chain just means "nothing to
// hydrate here", not an error.
export function parseRevisionChain(raw: string | null | undefined): RevisionChainEntry[] {
  if (!raw) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const entries: RevisionChainEntry[] = parsed
    .filter((entry): entry is { index?: unknown; bytes: string } => (
      !!entry && typeof entry === 'object' && typeof (entry as any).bytes === 'string'
    ))
    .map((entry) => ({
      index: Number.isInteger(entry.index) ? (entry.index as number) : 1,
      bytes: entry.bytes,
    }));

  if (entries.length < 2) return [];
  return entries.slice().sort((a, b) => a.index - b.index);
}

export default {
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
};
