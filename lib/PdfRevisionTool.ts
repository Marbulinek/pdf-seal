'use strict';

import PdfSignatureTool from './PdfSignatureTool';

/**
 * PdfRevisionTool
 * ----------------
 * PDFs that have been incrementally updated -- which is the normal way a
 * PDF gains a digital signature, a form-fill, or an annotation after its
 * first save -- literally carry their own revision history inside the
 * file:
 *
 *   1. Every incremental update APPENDS new objects plus a fresh xref
 *      section and a `startxref <offset> %%EOF` trailer, without ever
 *      touching the bytes that came before it.
 *   2. Because of that, truncating the file right after any one of those
 *      `%%EOF` markers yields a complete, independently valid PDF exactly
 *      as it existed at that point in time -- no reconstruction needed,
 *      pdf-lib can just load the byte slice directly.
 *
 * This tool (a) finds those revision boundaries, (b) loads each snapshot
 * independently via PdfSignatureTool to summarize it, and (c) diffs two
 * snapshots against each other, both at a "what changed" summary level
 * (metadata, fields, signatures) and at the raw PDF-object level.
 *
 * A PDF that was only ever saved once (no incremental updates) simply has
 * one revision -- the whole file.
 */

// Matches the trailer every revision ends with. Cheap and, in practice,
// reliable: this exact token sequence is how incremental updates are
// required to close (ISO 32000-1 §7.5.5), and the tiny risk of it
// coincidentally appearing inside binary stream data is an acceptable
// trade-off for not having to hand-roll a full xref/trailer parser just
// to list revisions.
const REVISION_BOUNDARY_PATTERN = /startxref\s+(\d+)\s*%%EOF/g;

interface RevisionBoundary {
  index: number; // 1-based, oldest revision first
  xrefOffset: number;
  endOffset: number; // exclusive byte length of this revision's snapshot
}

function findRevisionBoundaries(bytes: Uint8Array): RevisionBoundary[] {
  // The pattern only ever needs to match ASCII keywords/digits. A latin1
  // decode is a lossless 1-byte-to-1-char mapping, which keeps match
  // offsets numerically identical to byte offsets -- unlike a UTF-8
  // decode, which could shift offsets around multi-byte sequences that
  // happen to occur in binary stream data.
  const text = Buffer.from(bytes).toString('latin1');
  const boundaries: RevisionBoundary[] = [];
  let match: RegExpExecArray | null;
  REVISION_BOUNDARY_PATTERN.lastIndex = 0;
  while ((match = REVISION_BOUNDARY_PATTERN.exec(text)) !== null) {
    boundaries.push({
      index: boundaries.length + 1,
      xrefOffset: parseInt(match[1], 10),
      endOffset: match.index + match[0].length,
    });
  }
  return boundaries;
}

/** Byte slice for one revision, given its boundary (or the whole file for the final one). */
function snapshotBytesFor(bytes: Uint8Array, boundaries: RevisionBoundary[], revisionIndex: number): Uint8Array {
  if (boundaries.length === 0) {
    if (revisionIndex !== 1) throw new Error(`Revision ${revisionIndex} does not exist.`);
    return bytes;
  }
  const boundary = boundaries.find((b) => b.index === revisionIndex);
  if (!boundary) throw new Error(`Revision ${revisionIndex} does not exist.`);
  const isFinal = boundary.index === boundaries[boundaries.length - 1].index;
  // Use the full original buffer for the final revision (rather than
  // slicing at its own boundary) so any trailing bytes after the very
  // last %%EOF -- stray whitespace, a final newline -- are never dropped.
  return isFinal ? bytes : bytes.subarray(0, boundary.endOffset);
}

async function summarizeSnapshot(bytes: Uint8Array, revisionIndex: number, isFinal: boolean, boundary: RevisionBoundary | null) {
  const base = {
    index: revisionIndex,
    isFinal,
    byteLength: bytes.length,
    xrefOffset: boundary ? boundary.xrefOffset : null,
  };
  try {
    const tool = await PdfSignatureTool.fromBytes(bytes);
    const metadata = tool.getMetadata();
    const fields = tool.listFields().map((f: any) => ({
      name: f.name,
      type: f.type,
      required: f.required,
      readOnly: f.readOnly,
      page: f.page,
    }));
    const signatures = tool.getSignatureInfo();
    const rawDump = tool.getFullRawDump();
    const changeSummary = {
      pageCount: metadata.pageCount,
      textCount: countTextItems(fields, rawDump),
      imageCount: countImages(rawDump),
      fieldCount: fields.length,
      acroFormCount: countAcroFormObjects(rawDump),
      metadataFieldCount: countMetadataFields(metadata),
      signatureCount: signatures.length,
    };
    return {
      ...base,
      parseError: null,
      pageCount: metadata.pageCount,
      metadata,
      fields,
      signatures,
      changeSummary,
    };
  } catch (error: any) {
    return {
      ...base,
      parseError: error?.message || 'Could not parse this revision as a standalone PDF.',
      pageCount: null,
      metadata: null,
      fields: null,
      signatures: [],
    };
  }
}

/**
 * List every revision found in the file, oldest first, each with enough
 * summary data (metadata, fields, signatures, byte size) to render a
 * revision history UI without a second round-trip.
 */
async function readEmbeddedSnapshots(bytes: Uint8Array) {
  try {
    const tool = await PdfSignatureTool.fromBytes(bytes);
    const chain = tool.getRevisionSnapshotChain();
    if (!Array.isArray(chain) || !chain.length) return null;

    const snapshots: Array<{ index: number; bytes: Uint8Array }> = [];
    for (const entry of chain) {
      const snapshotBytes = Buffer.from(entry.bytes, 'base64');
      if (!snapshotBytes.length) continue;
      snapshots.push({
        index: Number.isInteger(entry.index) ? entry.index : 1,
        bytes: snapshotBytes,
      });
    }
    return snapshots;
  } catch (_err) {
    return null;
  }
}

async function listRevisions(bytes: Uint8Array) {
  const embeddedSnapshots = await readEmbeddedSnapshots(bytes);
  if (embeddedSnapshots?.length) {
    const revisions = [];
    for (let i = 0; i < embeddedSnapshots.length; i++) {
      const snapshot = embeddedSnapshots[i];
      if (!snapshot) continue;
      revisions.push(await summarizeSnapshot(snapshot.bytes, snapshot.index, i === embeddedSnapshots.length - 1, null));
    }
    return revisions;
  }

  const boundaries = findRevisionBoundaries(bytes);

  if (boundaries.length === 0) {
    // No incremental updates detected -- report the whole file as a
    // single revision so the UI has something consistent to render.
    return [await summarizeSnapshot(bytes, 1, true, null)];
  }

  const revisions = [];
  for (let i = 0; i < boundaries.length; i++) {
    const boundary = boundaries[i];
    const isFinal = i === boundaries.length - 1;
    const snapshotBytes = isFinal ? bytes : bytes.subarray(0, boundary.endOffset);
    revisions.push(await summarizeSnapshot(snapshotBytes, boundary.index, isFinal, boundary));
  }
  return revisions;
}

// ---------------------------------------------------------------------
// Diffing
// ---------------------------------------------------------------------

function countAnnotations(rawDump: any): number {
  const objects = rawDump?.objects || {};
  return Object.values(objects).filter((value: any) => {
    if (!value || typeof value !== 'object') return false;
    const type = typeof value.Type === 'string' ? value.Type : '';
    const subtype = typeof value.Subtype === 'string' ? value.Subtype : '';
    return type === 'Annot' || subtype === 'Widget' || subtype === 'Text' || subtype === 'FreeText';
  }).length;
}

function countImages(rawDump: any): number {
  const objects = rawDump?.objects || {};
  return Object.values(objects).filter((value: any) => {
    if (!value || typeof value !== 'object') return false;
    return typeof value.Subtype === 'string' && value.Subtype === 'Image';
  }).length;
}

function countAcroFormObjects(rawDump: any): number {
  const objects = rawDump?.objects || {};
  return Object.values(objects).filter((value: any) => {
    if (!value || typeof value !== 'object') return false;
    const subtype = typeof value.Subtype === 'string' ? value.Subtype : '';
    const ft = typeof value.FT === 'string' ? value.FT : '';
    const type = typeof value.Type === 'string' ? value.Type : '';
    return subtype === 'Widget' || ft !== '' || type === 'AcroForm';
  }).length;
}

function countMetadataFields(metadata: any): number {
  if (!metadata || typeof metadata !== 'object') return 0;
  const keys = ['title', 'author', 'subject', 'keywords', 'producer', 'creator', 'creationDate', 'modificationDate'];
  return keys.filter((k) => metadata[k] != null && metadata[k] !== '').length;
}

function countTextItems(fields: any[], rawDump: any): number {
  const textFields = (fields || []).filter((field: any) => /text/i.test(field?.type || '')).length;
  const objects = rawDump?.objects || {};
  const textAnnotations = Object.values(objects).filter((value: any) => {
    if (!value || typeof value !== 'object') return false;
    const subtype = typeof value.Subtype === 'string' ? value.Subtype : '';
    return subtype === 'Text' || subtype === 'FreeText';
  }).length;
  return textFields + textAnnotations;
}

function diffMetadata(a: any, b: any) {
  const changes: Array<{ key: string; before: any; after: any }> = [];
  if (!a || !b) return changes;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (key === 'pageCount') continue; // reported separately, as pageCountDelta
    const before = a[key] ?? null;
    const after = b[key] ?? null;
    if (JSON.stringify(before) !== JSON.stringify(after)) changes.push({ key, before, after });
  }
  return changes;
}

function diffFields(a: any[] | null, b: any[] | null) {
  const before = new Map((a || []).map((f) => [f.name, f]));
  const after = new Map((b || []).map((f) => [f.name, f]));

  const added: any[] = [];
  const modified: Array<{ name: string; changes: Array<{ key: string; before: any; after: any }> }> = [];
  for (const [name, field] of after) {
    const prev = before.get(name);
    if (!prev) {
      added.push(field);
      continue;
    }
    const fieldChanges: Array<{ key: string; before: any; after: any }> = [];
    for (const key of ['type', 'required', 'readOnly', 'page']) {
      if (JSON.stringify(prev[key]) !== JSON.stringify((field as any)[key])) {
        fieldChanges.push({ key, before: prev[key], after: (field as any)[key] });
      }
    }
    if (fieldChanges.length) modified.push({ name, changes: fieldChanges });
  }

  const removed: any[] = [];
  for (const [name, field] of before) {
    if (!after.has(name)) removed.push(field);
  }

  return { added, removed, modified };
}

function diffSignatures(a: any[], b: any[]) {
  const before = new Map((a || []).map((s) => [s.fieldName, s]));
  const after = new Map((b || []).map((s) => [s.fieldName, s]));
  const added: any[] = [];
  for (const [name, sig] of after) if (!before.has(name)) added.push(sig);
  const removed: any[] = [];
  for (const [name, sig] of before) if (!after.has(name)) removed.push(sig);
  return { added, removed };
}

// Cap how many raw-object diff entries we ever hand back -- a large,
// heavily-revised PDF could otherwise produce a payload proportional to
// its entire object table on every diff request.
const MAX_OBJECT_DIFF_ENTRIES = 500;

interface RawObjectRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface RawObjectPreview {
  key: string;
  page: number | null;
  rects: RawObjectRect[];
  type: string | null;
  subtype: string | null;
  previewMode: 'rects' | 'visual-page' | 'none';
  hasVisualLocation: boolean;
  /** Human-readable bucket, e.g. "Signature", "Page", "Form Field". */
  category: string;
  /** AcroForm field name this object belongs to, if any (e.g. "Signature1"). */
  fieldName: string | null;
  /** PDF-syntax-flavored one-liner of this object's own (current) dict entries, e.g. "/Type /Sig /Filter /Adobe.PPKLite ...". Kept for backward compatibility -- prefer dictionaryChanges for an actual before/after. */
  changesText: string;
  /** e.g. "Page 1 Content Stream", "Signature Dictionary", "Widget Annotation (Signature1)". */
  humanName: string;
  /** "<key> — <humanName>", the raw ref kept alongside its human-readable meaning per the revision viewer's display requirement. */
  label: string;
  /** Structured before/after per changed dict key (or all-added/all-removed for an object that only exists on one side). */
  dictionaryChanges: DictionaryChangeEntry[];
  /** Decoded content-stream diff, or null if this object isn't a (decodable) stream. */
  streamDiff: StreamDiffResult | null;
  /** One or more of: 'structural' | 'dictionary' | 'content-stream' | 'visual-content' | 'signing'. */
  classifications: string[];
}

function normalizeRect(rawRect: any): RawObjectRect | null {
  if (!Array.isArray(rawRect) || rawRect.length < 4) return null;
  const [x1, y1, x2, y2] = rawRect.map((value) => Number(value));
  if (![x1, y1, x2, y2].every(Number.isFinite)) return null;
  const left = Math.min(x1, x2);
  const right = Math.max(x1, x2);
  const bottom = Math.min(y1, y2);
  const top = Math.max(y1, y2);
  return {
    x: left,
    y: bottom,
    width: right - left,
    height: top - bottom,
  };
}

function buildPageRefIndex(rawDump: any) {
  const objects = rawDump?.objects || {};
  const pageRefs = new Map<string, number>();
  const visited = new Set<string>();

  const visit = (ref: any) => {
    if (typeof ref !== 'string' || visited.has(ref)) return;
    visited.add(ref);
    const node = objects[ref];
    if (!node || typeof node !== 'object') return;
    if (node.Type === 'Page') {
      pageRefs.set(ref, pageRefs.size);
      return;
    }
    if (Array.isArray(node.Kids)) {
      node.Kids.forEach(visit);
    }
  };

  const rootRef = rawDump?.trailer?.Root;
  const root = typeof rootRef === 'string' ? objects[rootRef] : null;
  if (root && typeof root === 'object' && typeof root.Pages === 'string') {
    visit(root.Pages);
  }

  if (!pageRefs.size) {
    Object.entries(objects).forEach(([ref, node]) => {
      if (node && typeof node === 'object' && (node as any).Type === 'Page') {
        pageRefs.set(ref, pageRefs.size);
      }
    });
  }

  return pageRefs;
}

function buildAnnotationPageIndex(rawDump: any, pageRefs: Map<string, number>) {
  const objects = rawDump?.objects || {};
  const annotationPages = new Map<string, number>();

  for (const [pageRef, pageIndex] of pageRefs.entries()) {
    const pageNode = objects[pageRef];
    if (!pageNode || typeof pageNode !== 'object' || !Array.isArray((pageNode as any).Annots)) continue;
    for (const annotRef of (pageNode as any).Annots) {
      if (typeof annotRef === 'string') annotationPages.set(annotRef, pageIndex);
    }
  }

  return annotationPages;
}

function buildContentStreamPageIndex(rawDump: any, pageRefs: Map<string, number>) {
  const objects = rawDump?.objects || {};
  const contentPages = new Map<string, number>();

  const collectRefs = (value: any): string[] => {
    if (typeof value === 'string') return [value];
    if (Array.isArray(value)) return value.filter((item) => typeof item === 'string');
    return [];
  };

  for (const [pageRef, pageIndex] of pageRefs.entries()) {
    const pageNode = objects[pageRef];
    if (!pageNode || typeof pageNode !== 'object') continue;
    for (const ref of collectRefs((pageNode as any).Contents)) {
      contentPages.set(ref, pageIndex);
    }
  }

  return contentPages;
}

function collectExplicitRects(node: any): RawObjectRect[] {
  const rect = node && typeof node === 'object' ? normalizeRect(node.Rect) : null;
  return rect ? [rect] : [];
}

function rectsFromAnnotationRefs(refs: any[], rawDump: any) {
  const objects = rawDump?.objects || {};
  const rects: RawObjectRect[] = [];
  for (const ref of refs) {
    if (typeof ref !== 'string') continue;
    const rect = normalizeRect(objects[ref]?.Rect);
    if (rect) rects.push(rect);
  }
  return rects;
}

function uniqueRects(rects: RawObjectRect[]) {
  const seen = new Set<string>();
  return rects.filter((rect) => {
    const key = `${rect.x}:${rect.y}:${rect.width}:${rect.height}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------
// Human-readable object summaries -- turns a raw "31 0 R" key plus its
// plain-data dict (as produced by PdfSignatureTool.getFullRawDump) into
// the kind of one-line, PDF-syntax-flavored description a person can
// actually scan: /Type /Sig /Filter /Adobe.PPKLite /ByteRange [...]
// /Contents <binary, 4096 bytes>, instead of just the bare object ref.
// ---------------------------------------------------------------------

// Dict keys whose value is conventionally a PDF Name (i.e. it should be
// rendered with a leading slash, like the key itself) rather than as a
// plain string or literal -- pdfValueToPlain() already stripped that
// distinction away, so this is a best-effort allowlist of the common
// ones rather than something derived from the data itself.
const NAME_VALUED_DICT_KEYS = new Set([
  'Type', 'Subtype', 'FT', 'Filter', 'SubFilter', 'S', 'BM', 'Intent', 'Encoding', 'BaseFont', 'ColorSpace',
]);

// Values longer than this are almost certainly binary/opaque payloads
// (signature hashes, embedded fonts, image samples) -- worth flagging
// their size rather than dumping the content inline.
const BINARY_VALUE_THRESHOLD = 80;
const MAX_CHANGES_ENTRIES = 12;

function formatPdfDictValue(key: string, value: any): string {
  if (value === null || value === undefined) return 'null';
  if (key === 'Contents' && typeof value === 'string') {
    return `<binary, ${value.length} bytes>`;
  }
  if (Array.isArray(value)) {
    if (value.length > 6 || value.some((item) => item !== null && typeof item === 'object')) return '[...]';
    return `[${value.map((item) => formatPdfDictValue('', item)).join(' ')}]`;
  }
  if (typeof value === 'object') return '<<...>>';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') {
    if (value.length > BINARY_VALUE_THRESHOLD) return `<binary, ${value.length} chars>`;
    return NAME_VALUED_DICT_KEYS.has(key) ? `/${value}` : `(${value})`;
  }
  return String(value);
}

/** PDF-syntax-flavored one-liner of a dict's own entries, capped so a huge Resources dict etc. doesn't blow up the response. */
function formatObjectChanges(node: any): string {
  if (Array.isArray(node)) {
    return node.length ? `[${node.map((item) => formatPdfDictValue('', item)).join(' ')}]` : '[]';
  }
  if (!node || typeof node !== 'object') return node == null ? '' : String(node);

  const keys = Object.keys(node).filter((k) => k !== '@type' && k !== '@rawByteLength');
  // Lead with Type/Subtype/FT so what the object *is* reads first.
  const priority = ['Type', 'Subtype', 'FT'];
  keys.sort((a, b) => {
    const pa = priority.indexOf(a);
    const pb = priority.indexOf(b);
    if (pa !== -1 || pb !== -1) return (pa === -1 ? priority.length : pa) - (pb === -1 ? priority.length : pb);
    return a.localeCompare(b);
  });

  const shown = keys.slice(0, MAX_CHANGES_ENTRIES);
  const parts = shown.map((k) => `/${k} ${formatPdfDictValue(k, node[k])}`);
  if (keys.length > shown.length) parts.push(`… +${keys.length - shown.length} more`);
  return parts.join(' ');
}

/**
 * Resolve the AcroForm field name (the /T entry) an object belongs to,
 * whether the object IS the field/widget itself, is a widget nested
 * under a parent field, or is a signature dictionary pointed to by some
 * widget's /V -- e.g. a "31 0 R" signature dict has no /T of its own,
 * but the widget that names it "Signature1" does.
 */
function resolveFieldName(key: string, node: any, objects: Record<string, any>): string | null {
  if (node && typeof node === 'object' && typeof node.T === 'string' && node.T) return node.T;

  let current = node;
  let depth = 0;
  while (current && typeof current === 'object' && typeof current.Parent === 'string' && depth < 6) {
    const parent = objects[current.Parent];
    if (!parent || typeof parent !== 'object') break;
    if (typeof parent.T === 'string' && parent.T) return parent.T;
    current = parent;
    depth += 1;
  }

  for (const other of Object.values(objects)) {
    if (!other || typeof other !== 'object') continue;
    if ((other as any).V === key && typeof (other as any).T === 'string' && (other as any).T) {
      return (other as any).T;
    }
  }
  return null;
}

// ---------------------------------------------------------------------
// Dictionary-level before/after diffing -- as opposed to formatObjectChanges()
// above (which just prints the *current* dict), this compares two
// revisions' copies of the same object key by key so the UI can show
// "/Length: 500 → 560" instead of making the person diff two chip
// dumps by eye. An object that only exists in one revision (added or
// removed outright) has every one of its own entries reported as
// added/removed, since there is nothing on the other side to compare.
// ---------------------------------------------------------------------

interface DictionaryChangeEntry {
  key: string;
  before: string;
  after: string;
  status: 'added' | 'removed' | 'changed';
}

function buildDictionaryChanges(beforeNode: any, afterNode: any): DictionaryChangeEntry[] {
  const beforeDict = beforeNode && typeof beforeNode === 'object' && !Array.isArray(beforeNode) ? beforeNode : {};
  const afterDict = afterNode && typeof afterNode === 'object' && !Array.isArray(afterNode) ? afterNode : {};
  const keys = new Set([...Object.keys(beforeDict), ...Object.keys(afterDict)]);

  const changes: DictionaryChangeEntry[] = [];
  for (const key of keys) {
    if (key === '@type' || key === '@rawByteLength') continue;
    const hasBefore = Object.prototype.hasOwnProperty.call(beforeDict, key);
    const hasAfter = Object.prototype.hasOwnProperty.call(afterDict, key);
    const beforeVal = beforeDict[key];
    const afterVal = afterDict[key];
    if (hasBefore && hasAfter && JSON.stringify(beforeVal) === JSON.stringify(afterVal)) continue;

    changes.push({
      key,
      before: hasBefore ? formatPdfDictValue(key, beforeVal) : '—',
      after: hasAfter ? formatPdfDictValue(key, afterVal) : '—',
      status: !hasBefore ? 'added' : !hasAfter ? 'removed' : 'changed',
    });
  }

  changes.sort((a, b) => a.key.localeCompare(b.key));
  return changes.slice(0, MAX_CHANGES_ENTRIES);
}

// ---------------------------------------------------------------------
// Content-stream diffing -- for the subset of objects that carry an
// actual PDF stream (page content, mainly), compares the *decoded*
// bytes between two revisions rather than the compressed ones, so a
// re-flated-but-identical stream doesn't look like a content change
// just because /Length moved.
// ---------------------------------------------------------------------

interface StreamDiffResult {
  available: boolean;
  contentUnchanged: boolean;
  added: string[];
  removed: string[];
  truncated: boolean;
  rawByteLengthBefore: number | null;
  rawByteLengthAfter: number | null;
}

// Bounds the O(n*m) LCS table below -- content streams are normally a
// few hundred operators at most; a stream bigger than this still gets
// flagged as changed, just without a line-level breakdown.
const MAX_STREAM_DIFF_UNITS = 2000;

function isStreamNode(node: any): boolean {
  return !!node && typeof node === 'object' && node['@type'] === 'Stream';
}

/** Split decoded stream text into diffable units: lines if the producer wrote one operator per line (pdf-lib's own style), otherwise a rough PDF-token split as a fallback for minified/single-line streams. */
function splitStreamText(text: string): string[] {
  const lines = text.split(/\r\n|\r|\n/).filter((line) => line.trim().length > 0);
  if (lines.length > 1) return lines;
  const tokens = text.match(/\((?:\\.|[^\\)])*\)|<[^>]*>|\[[^\]]*\]|\S+/g);
  if (tokens && tokens.length > 1) return tokens;
  return text.trim() ? [text.trim()] : [];
}

/** Classic LCS-based diff -- unchanged units are dropped from the output entirely per the "don't show unchanged content" requirement, only the added/removed ones are kept. */
function diffTextUnits(oldUnits: string[], newUnits: string[]): { added: string[]; removed: string[]; truncated: boolean } {
  if (oldUnits.length > MAX_STREAM_DIFF_UNITS || newUnits.length > MAX_STREAM_DIFF_UNITS) {
    return { added: [], removed: [], truncated: true };
  }
  const n = oldUnits.length;
  const m = newUnits.length;
  const dp: Int32Array[] = new Array(n + 1);
  for (let i = 0; i <= n; i++) dp[i] = new Int32Array(m + 1);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = oldUnits[i] === newUnits[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const removed: string[] = [];
  const added: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldUnits[i] === newUnits[j]) {
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      removed.push(oldUnits[i]);
      i += 1;
    } else {
      added.push(newUnits[j]);
      j += 1;
    }
  }
  while (i < n) {
    removed.push(oldUnits[i]);
    i += 1;
  }
  while (j < m) {
    added.push(newUnits[j]);
    j += 1;
  }
  return { added, removed, truncated: false };
}

const NUM = String.raw`-?\d+(?:\.\d+)?`;

// Matches a PDF content-stream "x y w h re" (rectangle) operator --
// captures the same four numbers a person would read off the operator
// itself, e.g. "50 410 280 50 re f" defines (and then fills) a rectangle
// at x=50 y=410 width=280 height=50.
const CONTENT_RECT_OP_PATTERN = new RegExp(String.raw`(${NUM})\s+(${NUM})\s+(${NUM})\s+(${NUM})\s+re\b`, 'g');

// Matches a straight stroked line: "x1 y1 m x2 y2 l S" (or lowercase "s")
// -- the standard way to draw a strikethrough/underline/divider rule.
const CONTENT_LINE_OP_PATTERN = new RegExp(
  String.raw`(${NUM})\s+(${NUM})\s+m\s+(${NUM})\s+(${NUM})\s+l\s+[sS]\b`, 'g',
);

// A PDF string literal's inner content. The spec allows unescaped
// parentheses inside a literal string as long as they're balanced, e.g.
// "(-> 5 Weeks (Extended for audit))" is ONE string, not two -- so a
// naive "stop at the first unescaped )" pattern fails to match it at
// all. This handles up to one level of that nesting (the overwhelming
// common case for a short label); anything nested deeper than that
// falls back to not matching, same as before.
const PDF_STRING_LITERAL_INNER = String.raw`(?:\\.|[^\\()]|\((?:\\.|[^\\()])*\))*`;

// Matches one self-contained "show text at this position" unit --
// "/FontName size Tf x y Td (text) Tj" -- as commonly written when a
// producer emits one BT..ET block per line. Font size is needed to
// estimate the text's on-page footprint.
const CONTENT_TEXT_OP_PATTERN = new RegExp(
  String.raw`\/\S+\s+(${NUM})\s+Tf\s+(${NUM})\s+(${NUM})\s+Td\s*\((${PDF_STRING_LITERAL_INNER})\)\s*Tj`, 'g',
);

// Rough average glyph-width-to-font-size ratio for common text -- good
// enough for a highlight box, not for real layout.
const AVG_CHAR_WIDTH_RATIO = 0.55;

function rectFromPoints(x1: number, y1: number, x2: number, y2: number): RawObjectRect | null {
  if (![x1, y1, x2, y2].every(Number.isFinite)) return null;
  // A couple of points of padding so a perfectly horizontal/vertical line
  // (zero width or height on its own) still renders as a visible box.
  const pad = 3;
  const left = Math.min(x1, x2) - pad;
  const right = Math.max(x1, x2) + pad;
  const bottom = Math.min(y1, y2) - pad;
  const top = Math.max(y1, y2) + pad;
  return { x: left, y: bottom, width: right - left, height: top - bottom };
}

/**
 * Pull the drawing operators out of a content-stream diff's added/removed
 * lines and turn each one into a page-space rect: rectangles ("re"),
 * straight lines ("m ... l ... S", e.g. a strikethrough or underline
 * rule), and single-line text placements ("Tf ... Td (text) Tj").
 *
 * Without this, a content-stream change (e.g. adding one line of text,
 * striking through another, or drawing a stamp box) has no better preview
 * than a whole-page pixel diff, which highlights every visual difference
 * on the page -- including unrelated edits from other objects/revisions
 * -- instead of just the specific regions this object's diff actually
 * touched. Each distinct change gets its own rect here (deduplicated by
 * the caller), rather than only the last/only one that happened to match.
 */
function extractRectsFromStreamDiff(streamDiff: StreamDiffResult | null): RawObjectRect[] {
  if (!streamDiff || !streamDiff.available || streamDiff.contentUnchanged) return [];
  const rects: RawObjectRect[] = [];

  for (const line of [...streamDiff.added, ...streamDiff.removed]) {
    CONTENT_RECT_OP_PATTERN.lastIndex = 0;
    let rectMatch: RegExpExecArray | null;
    while ((rectMatch = CONTENT_RECT_OP_PATTERN.exec(line)) !== null) {
      const x = Number(rectMatch[1]);
      const y = Number(rectMatch[2]);
      const w = Number(rectMatch[3]);
      const h = Number(rectMatch[4]);
      if (![x, y, w, h].every(Number.isFinite) || w === 0 || h === 0) continue;
      rects.push({
        x: w < 0 ? x + w : x,
        y: h < 0 ? y + h : y,
        width: Math.abs(w),
        height: Math.abs(h),
      });
    }

    CONTENT_LINE_OP_PATTERN.lastIndex = 0;
    let lineMatch: RegExpExecArray | null;
    while ((lineMatch = CONTENT_LINE_OP_PATTERN.exec(line)) !== null) {
      const rect = rectFromPoints(Number(lineMatch[1]), Number(lineMatch[2]), Number(lineMatch[3]), Number(lineMatch[4]));
      if (rect) rects.push(rect);
    }

    CONTENT_TEXT_OP_PATTERN.lastIndex = 0;
    let textMatch: RegExpExecArray | null;
    while ((textMatch = CONTENT_TEXT_OP_PATTERN.exec(line)) !== null) {
      const fontSize = Number(textMatch[1]);
      const x = Number(textMatch[2]);
      const y = Number(textMatch[3]);
      const text = textMatch[4] || '';
      if (![fontSize, x, y].every(Number.isFinite) || fontSize <= 0 || !text.length) continue;
      rects.push({
        x,
        y: y - fontSize * 0.25, // allow room for descenders below the baseline
        width: Math.max(fontSize, text.length * fontSize * AVG_CHAR_WIDTH_RATIO),
        height: fontSize * 1.15,
      });
    }
  }

  return rects;
}

/**
 * Diff a stream object's decoded content between two revisions. `toolA`/
 * `toolB` may be null (this key doesn't exist in that revision, e.g. a
 * brand-new or fully-removed object) -- in that case the whole stream
 * on the side that does exist is reported as added/removed content.
 * Returns null when neither side is a decodable stream at all.
 */
function computeStreamDiff(key: string, toolA: any, toolB: any): StreamDiffResult | null {
  const before = toolA ? toolA.getStreamText(key) : null;
  const after = toolB ? toolB.getStreamText(key) : null;
  if (!before && !after) return null;

  if (before && after && before.text === after.text) {
    return {
      available: true,
      contentUnchanged: true,
      added: [],
      removed: [],
      truncated: false,
      rawByteLengthBefore: before.rawByteLength,
      rawByteLengthAfter: after.rawByteLength,
    };
  }

  const oldUnits = before ? splitStreamText(before.text) : [];
  const newUnits = after ? splitStreamText(after.text) : [];
  const { added, removed, truncated } = diffTextUnits(oldUnits, newUnits);

  return {
    available: true,
    contentUnchanged: false,
    added,
    removed,
    truncated,
    rawByteLengthBefore: before ? before.rawByteLength : null,
    rawByteLengthAfter: after ? after.rawByteLength : null,
  };
}

// ---------------------------------------------------------------------
// Human-readable naming + change classification
// ---------------------------------------------------------------------

function humanObjectName(node: any, category: ObjectCategory, page: number | null, fieldName: string | null): string {
  const type = node && typeof node === 'object' && typeof node.Type === 'string' ? node.Type : null;
  const subFilter = node && typeof node === 'object' && typeof node.SubFilter === 'string' ? node.SubFilter : null;

  if (type === 'DSS') return 'Document Security Store (DSS)';
  if (type === 'VRI') return 'Validation-Related Info (VRI)';
  if (type === 'DocTimeStamp' || subFilter === 'ETSI.RFC3161') return 'Timestamp';

  const withField = (base: string) => (fieldName ? `${base} (${fieldName})` : base);

  switch (category) {
    case 'page':
      return page !== null ? `Page ${page + 1}` : 'Page';
    case 'content':
      return page !== null ? `Page ${page + 1} Content Stream` : 'Content Stream';
    case 'image':
      return page !== null ? `Page ${page + 1} Image` : 'Image';
    case 'signatureField':
      return type === 'Sig' ? 'Signature Dictionary' : withField('Signature Field');
    case 'formField':
      return node && node.Subtype === 'Widget' ? withField('Widget Annotation') : withField('Form Field');
    case 'acroform':
      return 'AcroForm';
    case 'xmp':
      return 'XMP Metadata';
    case 'font':
      return 'Font';
    default:
      return 'Object';
  }
}

const SIGNING_DICT_KEYS = new Set(['ByteRange', 'Contents', 'Filter', 'SubFilter']);

function classifyChanges(params: {
  dictionaryChanges: DictionaryChangeEntry[];
  streamDiff: StreamDiffResult | null;
  category: ObjectCategory;
  node: any;
}): string[] {
  const { dictionaryChanges, streamDiff, category, node } = params;
  const tags = new Set<string>();

  const hasLengthChange = dictionaryChanges.some((c) => c.key === 'Length');
  const nonLengthChanges = dictionaryChanges.filter((c) => c.key !== 'Length');

  if (streamDiff && streamDiff.available && !streamDiff.contentUnchanged) {
    tags.add('content-stream');
    if (category === 'content' || category === 'image') tags.add('visual-content');
  } else if (hasLengthChange) {
    // /Length moved but the decoded content is identical (or couldn't be
    // compared) -- a byte-size/structural change, not a content one.
    tags.add('structural');
  }

  if (nonLengthChanges.length) tags.add('dictionary');

  const type = node && typeof node === 'object' && typeof node.Type === 'string' ? node.Type : null;
  const isSigningRelated =
    category === 'signatureField' ||
    type === 'Sig' || type === 'DSS' || type === 'VRI' || type === 'DocTimeStamp' ||
    dictionaryChanges.some((c) => SIGNING_DICT_KEYS.has(c.key));
  if (isSigningRelated) tags.add('signing');

  if (!tags.size) tags.add('dictionary');
  return Array.from(tags);
}

function describeRawObject(
  key: string,
  dumpA: any,
  dumpB: any,
  pageRefs: Map<string, number>,
  annotationPages: Map<string, number>,
  contentStreamPages: Map<string, number>,
  category: ObjectCategory,
  toolA: any,
  toolB: any,
  independentlyTrackedKeys: Set<string>,
): RawObjectPreview {
  const objectsA = dumpA?.objects || {};
  const objectsB = dumpB?.objects || {};
  const beforeNode = objectsA[key];
  const node = objectsB[key];
  const type = node && typeof node === 'object' && typeof node.Type === 'string' ? node.Type : null;
  const subtype = node && typeof node === 'object' && typeof node.Subtype === 'string' ? node.Subtype : null;

  let pageRef = node && typeof node === 'object' && typeof node.P === 'string' ? node.P : null;
  if (!pageRef && annotationPages.has(key)) {
    const pageIndex = annotationPages.get(key)!;
    pageRef = Array.from(pageRefs.entries()).find(([, idx]) => idx === pageIndex)?.[0] || null;
  }
  const page = pageRef && pageRefs.has(pageRef)
    ? pageRefs.get(pageRef)!
    : (pageRefs.get(key) ?? annotationPages.get(key) ?? contentStreamPages.get(key) ?? null);

  let rects = collectExplicitRects(node);

  if (!rects.length && type === 'Page' && node && typeof node === 'object') {
    const beforeAnnots = Array.isArray(beforeNode?.Annots) ? beforeNode.Annots : [];
    const afterAnnots = Array.isArray(node.Annots) ? node.Annots : [];
    // A newly-attached annotation (e.g. a signature widget just added to
    // this page) is *also* reported as its own added/modified object --
    // with its own /Rect -- elsewhere in this same diff. Deriving the
    // page's rect from it too would draw/report that one rectangle twice
    // under two unrelated-looking entries (e.g. "Page 1" and "6 0 R"),
    // which is exactly the duplicate/overlapping-change bug this guards
    // against: only fall back to an annotation's rect here if that
    // annotation ISN'T already independently tracked in this diff.
    const changedRefs = afterAnnots.filter(
      (ref: any) => !beforeAnnots.includes(ref) && !independentlyTrackedKeys.has(ref),
    );
    rects = rectsFromAnnotationRefs(changedRefs, dumpB);
  }

  const streamDiff = isStreamNode(beforeNode) || isStreamNode(node) ? computeStreamDiff(key, toolA, toolB) : null;

  // A content stream has no /Rect of its own -- without this, ANY change
  // to it (even one that only drew a single small box) falls back to a
  // whole-page pixel diff that highlights every visual difference on the
  // page, not just this object's own. When its diff text contains
  // rectangle-drawing operators, use those instead for an exact preview.
  if (!rects.length && streamDiff) {
    rects = extractRectsFromStreamDiff(streamDiff);
  }

  rects = uniqueRects(rects);
  const previewMode = rects.length > 0
    ? 'rects'
    : (page !== null && contentStreamPages.has(key) ? 'visual-page' : 'none');

  const fieldName = resolveFieldName(key, node, objectsB);
  const dictionaryChanges = buildDictionaryChanges(beforeNode, node);
  const classifications = classifyChanges({ dictionaryChanges, streamDiff, category, node });
  const humanName = humanObjectName(node, category, page, fieldName);

  return {
    key,
    page,
    rects,
    type,
    subtype,
    previewMode,
    hasVisualLocation: previewMode !== 'none',
    category: CATEGORY_LABELS[category],
    fieldName,
    changesText: formatObjectChanges(node),
    humanName,
    label: `${key} — ${humanName}`,
    dictionaryChanges,
    streamDiff,
    classifications,
  };
}

/** Mirror of describeRawObject() for an object that only existed in the "from" snapshot (i.e. it was removed by the revision). */
function describeRemovedObject(
  key: string,
  dumpA: any,
  pageRefs: Map<string, number>,
  annotationPages: Map<string, number>,
  contentStreamPages: Map<string, number>,
  category: ObjectCategory,
  toolA: any,
): RawObjectPreview {
  const objectsA = dumpA?.objects || {};
  const node = objectsA[key];
  const type = node && typeof node === 'object' && typeof node.Type === 'string' ? node.Type : null;
  const subtype = node && typeof node === 'object' && typeof node.Subtype === 'string' ? node.Subtype : null;

  let pageRef = node && typeof node === 'object' && typeof node.P === 'string' ? node.P : null;
  if (!pageRef && annotationPages.has(key)) {
    const pageIndex = annotationPages.get(key)!;
    pageRef = Array.from(pageRefs.entries()).find(([, idx]) => idx === pageIndex)?.[0] || null;
  }
  const page = pageRef && pageRefs.has(pageRef)
    ? pageRefs.get(pageRef)!
    : (pageRefs.get(key) ?? annotationPages.get(key) ?? contentStreamPages.get(key) ?? null);

  let rects = collectExplicitRects(node);
  const streamDiff = isStreamNode(node) ? computeStreamDiff(key, toolA, null) : null;
  if (!rects.length && streamDiff) {
    rects = extractRectsFromStreamDiff(streamDiff);
  }
  rects = uniqueRects(rects);
  const previewMode = rects.length > 0
    ? 'rects'
    : (page !== null && contentStreamPages.has(key) ? 'visual-page' : 'none');

  const fieldName = resolveFieldName(key, node, objectsA);
  const dictionaryChanges = buildDictionaryChanges(node, null);
  const classifications = classifyChanges({ dictionaryChanges, streamDiff, category, node });
  const humanName = humanObjectName(node, category, page, fieldName);

  return {
    key,
    page,
    rects,
    type,
    subtype,
    previewMode,
    hasVisualLocation: previewMode !== 'none',
    category: CATEGORY_LABELS[category],
    fieldName,
    changesText: formatObjectChanges(node),
    humanName,
    label: `${key} — ${humanName}`,
    dictionaryChanges,
    streamDiff,
    classifications,
  };
}

// ---------------------------------------------------------------------
// Object classification -- buckets every added/removed/modified raw PDF
// object into one of a small set of human-meaningful categories so the
// UI can answer "did the pages / text / images / form / signature
// actually change" at a glance, instead of making the person read a
// flat list of object refs.
// ---------------------------------------------------------------------

type ObjectCategory =
  | 'page'
  | 'acroform'
  | 'content'
  | 'image'
  | 'signatureField'
  | 'formField'
  | 'xmp'
  | 'font'
  | 'other';

const CATEGORY_LABELS: Record<ObjectCategory, string> = {
  page: 'Page',
  acroform: 'AcroForm',
  content: 'Page Content',
  image: 'Image',
  signatureField: 'Signature',
  formField: 'Form Field',
  xmp: 'XMP Metadata',
  font: 'Font',
  other: 'Object',
};

function findAcroFormRef(dump: any): string | null {
  const objects = dump?.objects || {};
  const rootRef = dump?.trailer?.Root;
  const root = typeof rootRef === 'string' ? objects[rootRef] : null;
  return root && typeof root === 'object' && typeof root.AcroForm === 'string' ? root.AcroForm : null;
}

function classifyObjectKey(
  key: string,
  dumpA: any,
  dumpB: any,
  pageRefs: Map<string, number>,
  contentStreamPages: Map<string, number>,
  acroFormRef: string | null,
): ObjectCategory {
  const node = (dumpB?.objects || {})[key] ?? (dumpA?.objects || {})[key];
  if (key === acroFormRef) return 'acroform';
  if (pageRefs.has(key)) return 'page';
  if (contentStreamPages.has(key)) return 'content';
  if (!node || typeof node !== 'object') return 'other';

  const subtype = typeof node.Subtype === 'string' ? node.Subtype : '';
  const ft = typeof node.FT === 'string' ? node.FT : (typeof node.V === 'object' && node.V ? 'Sig' : '');
  if (subtype === 'Image') return 'image';
  if (subtype === 'Widget' || ft) return ft === 'Sig' ? 'signatureField' : 'formField';
  if (node.Type === 'Metadata') return 'xmp';
  if (node.Type === 'Font') return 'font';
  return 'other';
}

function diffRawObjects(dumpA: any, dumpB: any, toolA: any = null, toolB: any = null) {
  const objectsA = dumpA?.objects || {};
  const objectsB = dumpB?.objects || {};
  const keysA = new Set(Object.keys(objectsA));
  const keysB = new Set(Object.keys(objectsB));

  const added: string[] = [];
  const modified: string[] = [];
  for (const key of keysB) {
    if (!keysA.has(key)) {
      added.push(key);
    } else if (JSON.stringify(objectsA[key]) !== JSON.stringify(objectsB[key])) {
      modified.push(key);
    }
  }
  const removed: string[] = [];
  for (const key of keysA) {
    if (!keysB.has(key)) removed.push(key);
  }

  const truncated =
    added.length > MAX_OBJECT_DIFF_ENTRIES ||
    removed.length > MAX_OBJECT_DIFF_ENTRIES ||
    modified.length > MAX_OBJECT_DIFF_ENTRIES;

  const addedKeys = added.slice(0, MAX_OBJECT_DIFF_ENTRIES).sort();
  const removedKeys = removed.slice(0, MAX_OBJECT_DIFF_ENTRIES).sort();
  const modifiedKeys = modified.slice(0, MAX_OBJECT_DIFF_ENTRIES).sort();
  const pageRefs = buildPageRefIndex(dumpB);
  const annotationPages = buildAnnotationPageIndex(dumpB, pageRefs);
  const contentStreamPages = buildContentStreamPageIndex(dumpB, pageRefs);
  const acroFormRef = findAcroFormRef(dumpB) || findAcroFormRef(dumpA);

  const categories: Record<string, ObjectCategory> = {};
  for (const key of [...addedKeys, ...removedKeys, ...modifiedKeys]) {
    categories[key] = classifyObjectKey(key, dumpA, dumpB, pageRefs, contentStreamPages, acroFormRef);
  }

  const integrityIssues = findDanglingReferences([...addedKeys, ...modifiedKeys], dumpB);

  // Removed objects only exist in the "from" snapshot, so their page/
  // rect/field lookups need to run against dumpA's own indices rather
  // than dumpB's (which no longer contains them).
  const pageRefsA = buildPageRefIndex(dumpA);
  const annotationPagesA = buildAnnotationPageIndex(dumpA, pageRefsA);
  const contentStreamPagesA = buildContentStreamPageIndex(dumpA, pageRefsA);

  const withCategory = (preview: RawObjectPreview): RawObjectPreview => ({
    ...preview,
    category: CATEGORY_LABELS[categories[preview.key]] || CATEGORY_LABELS.other,
  });

  // Every key that already has its own added/modified/removed entry in this
  // diff -- passed into describeRawObject() so a Page's derived rect
  // doesn't re-report a rectangle that one of these entries already covers.
  const independentlyTrackedKeys = new Set<string>([...addedKeys, ...modifiedKeys, ...removedKeys]);

  return {
    added: addedKeys,
    removed: removedKeys,
    modified: modifiedKeys,
    addedDetails: addedKeys.map((key) => describeRawObject(key, dumpA, dumpB, pageRefs, annotationPages, contentStreamPages, categories[key], toolA, toolB, independentlyTrackedKeys)),
    modifiedDetails: modifiedKeys.map((key) => describeRawObject(key, dumpA, dumpB, pageRefs, annotationPages, contentStreamPages, categories[key], toolA, toolB, independentlyTrackedKeys)),
    removedDetails: removedKeys.map((key) => describeRemovedObject(key, dumpA, pageRefsA, annotationPagesA, contentStreamPagesA, categories[key], toolA)),
    truncated,
    categories,
    integrityIssues,
  };
}

/**
 * Sanity-check the objects a revision added or modified: do every
 * indirect reference they point to actually resolve to something in
 * this snapshot's object table? A dangling reference (an object that
 * points at "12 0 R" but no such object exists in the revision's own
 * dump) means the revision, taken as a standalone file, is malformed --
 * worth flagging up front rather than discovering it only when some
 * downstream viewer chokes on the file.
 */
function findDanglingReferences(keys: string[], dumpB: any): string[] {
  const objects = dumpB?.objects || {};
  const issues: string[] = [];
  const refPattern = /^\d+ \d+ R$/;

  const collectRefs = (value: any, depth: number, out: Set<string>) => {
    if (depth > 4 || value == null) return;
    if (typeof value === 'string') {
      if (refPattern.test(value)) out.add(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => collectRefs(item, depth + 1, out));
      return;
    }
    if (typeof value === 'object') {
      Object.values(value).forEach((item) => collectRefs(item, depth + 1, out));
    }
  };

  for (const key of keys.slice(0, MAX_OBJECT_DIFF_ENTRIES)) {
    const node = objects[key];
    if (!node || typeof node !== 'object') continue;
    const refs = new Set<string>();
    collectRefs(node, 0, refs);
    for (const ref of refs) {
      if (!objects[ref]) issues.push(`${key} references missing object ${ref}`);
    }
  }
  return issues.slice(0, 25); // keep this a short, scannable list, not a wall of text
}

/**
 * Cross-check that a newly-applied signature's /ByteRange actually
 * covers the revision it claims to sign -- i.e. that nothing was
 * appended after the signature within the same revision. A gap here
 * would mean the signature doesn't actually attest to the full
 * snapshot, which matters a lot more than a cosmetic diff does.
 */
function checkSignatureByteRangeCoverage(signaturesAdded: any[], byteLength: number): string[] {
  const issues: string[] = [];
  for (const sig of signaturesAdded) {
    const byteRange = Array.isArray(sig.byteRange) ? sig.byteRange : null;
    if (!byteRange || byteRange.length !== 4) {
      issues.push(`${sig.fieldName}: signature has no usable /ByteRange to verify coverage`);
      continue;
    }
    const [off1, , off2, len2] = byteRange;
    const coveredEnd = off2 + len2;
    // Small slack for a trailing newline/whitespace after the final %%EOF.
    if (off1 !== 0 || coveredEnd < byteLength - 4) {
      issues.push(
        `${sig.fieldName}: /ByteRange covers up to byte ${coveredEnd} but this revision is ${byteLength} bytes -- the signature may not cover the whole revision`,
      );
    }
  }
  return issues;
}

/**
 * Collapse a raw diff down to the seven at-a-glance checks the revision
 * panel surfaces: did pages / text / images change, and what happened
 * to the signature fields, AcroForm, metadata, and the cryptographic
 * signature itself.
 */
function buildRevisionChecklist(params: {
  pageCountDelta: number;
  objectChanges: ReturnType<typeof diffRawObjects>;
  metadataChanges: Array<{ key: string; before: any; after: any }>;
  signatureChanges: { added: any[]; removed: any[] };
}) {
  const { pageCountDelta, objectChanges, metadataChanges, signatureChanges } = params;
  const categoryValues = Object.values(objectChanges.categories || {});
  const countCat = (c: ObjectCategory) => categoryValues.filter((v) => v === c).length;

  const pagesChangedCount = countCat('page');
  const textChangedCount = countCat('content');
  const imagesChangedCount = countCat('image');
  const signatureFieldChangedCount = countCat('signatureField');
  const acroFormChangedCount = countCat('acroform') + countCat('formField');
  const signatureChangedCount = signatureChanges.added.length + signatureChanges.removed.length;

  return {
    pagesUnchanged: pageCountDelta === 0 && pagesChangedCount === 0,
    pagesChangedCount: Math.max(pagesChangedCount, pageCountDelta !== 0 ? 1 : 0),
    textUnchanged: textChangedCount === 0,
    textChangedCount,
    imagesUnchanged: imagesChangedCount === 0,
    imagesChangedCount,
    signatureFieldsUnchanged: signatureFieldChangedCount === 0,
    signatureFieldsChangedCount: signatureFieldChangedCount,
    acroFormUnchanged: acroFormChangedCount === 0,
    acroFormChangedCount,
    metadataUnchanged: metadataChanges.length === 0,
    metadataChangedCount: metadataChanges.length,
    signatureUnchanged: signatureChangedCount === 0,
    signatureChangedCount,
  };
}

async function diffSnapshotBytes(bytesA: Uint8Array, bytesB: Uint8Array) {
  const [toolA, toolB] = await Promise.all([
    PdfSignatureTool.fromBytes(bytesA).catch(() => null),
    PdfSignatureTool.fromBytes(bytesB).catch(() => null),
  ]);
  if (!toolA || !toolB) {
    throw new Error('One of the selected revisions could not be parsed as a standalone PDF, so it cannot be diffed.');
  }

  const metaA = toolA.getMetadata();
  const metaB = toolB.getMetadata();
  const metadataChanges = diffMetadata(metaA, metaB);
  const signatureChanges = diffSignatures(toolA.getSignatureInfo(), toolB.getSignatureInfo());
  const objectChanges = diffRawObjects(toolA.getFullRawDump(), toolB.getFullRawDump(), toolA, toolB);
  const pageCountDelta = (metaB.pageCount || 0) - (metaA.pageCount || 0);

  const integrityIssues = [
    ...objectChanges.integrityIssues,
    ...checkSignatureByteRangeCoverage(signatureChanges.added, bytesB.length),
  ];

  return {
    byteLengthDelta: bytesB.length - bytesA.length,
    pageCountDelta,
    metadataChanges,
    fieldChanges: diffFields(toolA.listFields(), toolB.listFields()),
    signatureChanges,
    objectChanges,
    checklist: buildRevisionChecklist({ pageCountDelta, objectChanges, metadataChanges, signatureChanges }),
    integrity: {
      ok: integrityIssues.length === 0,
      issues: integrityIssues,
    },
  };
}

/**
 * Diff two revisions of the same uploaded file by their 1-based revision
 * index (as returned by listRevisions()).
 */
async function diffRevisions(bytes: Uint8Array, fromIndex: number, toIndex: number) {
  const embeddedSnapshots = await readEmbeddedSnapshots(bytes);
  if (embeddedSnapshots?.length) {
    const bytesA = embeddedSnapshots.find((snapshot) => snapshot?.index === fromIndex)?.bytes;
    const bytesB = embeddedSnapshots.find((snapshot) => snapshot?.index === toIndex)?.bytes;
    if (bytesA && bytesB) {
      return diffSnapshotBytes(bytesA, bytesB);
    }
  }

  const boundaries = findRevisionBoundaries(bytes);
  const bytesA = snapshotBytesFor(bytes, boundaries, fromIndex);
  const bytesB = snapshotBytesFor(bytes, boundaries, toIndex);
  return diffSnapshotBytes(bytesA, bytesB);
}

async function getRevisionBytes(bytes: Uint8Array, revisionIndex: number): Promise<Uint8Array> {
  const embeddedSnapshots = await readEmbeddedSnapshots(bytes);
  if (embeddedSnapshots?.length) {
    const snapshot = embeddedSnapshots.find((entry) => entry?.index === revisionIndex);
    if (snapshot) return snapshot.bytes;
  }

  const boundaries = findRevisionBoundaries(bytes);
  return snapshotBytesFor(bytes, boundaries, revisionIndex);
}

export default {
  listRevisions,
  diffRevisions,
  findRevisionBoundaries,
  getRevisionBytes,
};