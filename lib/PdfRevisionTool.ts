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
      fieldCount: fields.length,
      signatureCount: signatures.length,
      textCount: countTextItems(fields, rawDump),
      annotationCount: countAnnotations(rawDump),
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

function describeRawObject(
  key: string,
  dumpA: any,
  dumpB: any,
  pageRefs: Map<string, number>,
  annotationPages: Map<string, number>,
  contentStreamPages: Map<string, number>,
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
    : (annotationPages.get(key) ?? contentStreamPages.get(key) ?? null);

  let rects = collectExplicitRects(node);

  if (!rects.length && type === 'Page' && node && typeof node === 'object') {
    const beforeAnnots = Array.isArray(beforeNode?.Annots) ? beforeNode.Annots : [];
    const afterAnnots = Array.isArray(node.Annots) ? node.Annots : [];
    const changedRefs = afterAnnots.filter((ref: any) => !beforeAnnots.includes(ref));
    rects = rectsFromAnnotationRefs(changedRefs, dumpB);
  }

  rects = uniqueRects(rects);
  const previewMode = rects.length > 0
    ? 'rects'
    : (page !== null && contentStreamPages.has(key) ? 'visual-page' : 'none');

  return {
    key,
    page,
    rects,
    type,
    subtype,
    previewMode,
    hasVisualLocation: previewMode !== 'none',
  };
}

function diffRawObjects(dumpA: any, dumpB: any) {
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

  return {
    added: addedKeys,
    removed: removedKeys,
    modified: modifiedKeys,
    addedDetails: addedKeys.map((key) => describeRawObject(key, dumpA, dumpB, pageRefs, annotationPages, contentStreamPages)),
    modifiedDetails: modifiedKeys.map((key) => describeRawObject(key, dumpA, dumpB, pageRefs, annotationPages, contentStreamPages)),
    truncated,
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

  return {
    byteLengthDelta: bytesB.length - bytesA.length,
    pageCountDelta: (metaB.pageCount || 0) - (metaA.pageCount || 0),
    metadataChanges: diffMetadata(metaA, metaB),
    fieldChanges: diffFields(toolA.listFields(), toolB.listFields()),
    signatureChanges: diffSignatures(toolA.getSignatureInfo(), toolB.getSignatureInfo()),
    objectChanges: diffRawObjects(toolA.getFullRawDump(), toolB.getFullRawDump()),
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
  getRevisionBytes,
};