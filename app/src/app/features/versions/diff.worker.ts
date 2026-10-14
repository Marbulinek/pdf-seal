/// <reference lib="webworker" />
/*
 * Off-main-thread pixel diffing for the visual revision diff.
 *
 * Comparing two rendered PDF pages means touching width*height*4 bytes. On the
 * main thread that froze the tab outright (a letter page at 300% zoom is ~47M
 * array accesses), and it re-ran on every page-nav click. Here it runs on a
 * worker, so the UI stays live.
 *
 * This worker also OWNS the rendered-page pixel cache. The main thread renders
 * a page once, transfers the pixels here under a key, and afterwards only ever
 * sends the key -- so paging back and forth costs no pdf.js render and no
 * buffer copying at all. Transfers are zero-copy in both directions, which is
 * why the pixels live here rather than being shipped back and forth per diff.
 *
 * Both diff modes answer with geometry (a few hundred rectangles at most)
 * rather than a whole tinted page, so nothing large travels back. The message
 * shapes are in diff-worker-protocol.ts.
 */

import type { DiffRect, DiffWorkerMessage, DiffWorkerReply } from './diff-worker-protocol';
import { groupStrokes } from './visual-diff-strokes';

// Two pixels count as different when their channel deltas sum past this. Kept
// identical to the original main-thread implementation so the highlighted
// regions don't shift.
const DELTA_THRESHOLD = 20;

interface CachedPage {
  pixels: Uint8ClampedArray;
  /**
   * A 32-bit view over the same bytes: comparing whole pixels as single words
   * lets the scan skip the (overwhelmingly common) identical pixels without
   * doing any per-channel arithmetic.
   */
  words: Uint32Array;
  width: number;
  height: number;
}

type DiffMessage = Extract<DiffWorkerMessage, { type: 'diff' }>;
type Payload = Omit<DiffWorkerReply, 'id' | 'ok'>;

const pageCache = new Map<string, CachedPage>();

function store(key: string, buf: ArrayBuffer, width: number, height: number): void {
  pageCache.set(key, { pixels: new Uint8ClampedArray(buf), words: new Uint32Array(buf), width, height });
}

function get(key: string): CachedPage {
  const entry = pageCache.get(key);
  if (!entry) throw new Error(`Pixel cache miss for "${key}".`);
  return entry;
}

/**
 * Walk both pages, calling `onDiff(pixelIndex)` for each differing pixel.
 * Returns the pixel count so callers can size their own buffers.
 */
function scanDiff(a: CachedPage, b: CachedPage, onDiff: (pixel: number) => void): number {
  const count = Math.min(a.words.length, b.words.length);
  const aw = a.words;
  const bw = b.words;
  const ap = a.pixels;
  const bp = b.pixels;

  for (let p = 0; p < count; p++) {
    // Fast path: byte-identical pixel. This is most of a typical page, and
    // skipping it here is what makes the whole scan cheap.
    if (aw[p] === bw[p]) continue;
    const i = p << 2;
    const delta =
      Math.abs(ap[i] - bp[i]) +
      Math.abs(ap[i + 1] - bp[i + 1]) +
      Math.abs(ap[i + 2] - bp[i + 2]) +
      Math.abs(ap[i + 3] - bp[i + 3]);
    if (delta > DELTA_THRESHOLD) onDiff(p);
  }
  return count;
}

// Reduce the changed pixels to highlighter strokes: one pass over the two
// pages fills a coarse occupancy grid, which groupStrokes() then bands.
function diffStrokes(msg: Extract<DiffMessage, { mode: 'strokes' }>): Payload {
  const a = get(msg.keyA);
  const b = get(msg.keyB);
  const width = Math.min(a.width, b.width);
  const height = Math.min(a.height, b.height);
  const colCell = msg.colCell;
  const cols = Math.ceil(width / colCell);
  const srcWidth = a.width;

  const dirty = new Uint8Array(cols * height);
  const rowCounts = new Uint32Array(height);

  scanDiff(a, b, (p) => {
    const row = (p / srcWidth) | 0;
    const col = p % srcWidth;
    if (row >= height || col >= width) return;
    dirty[row * cols + ((col / colCell) | 0)] = 1;
    rowCounts[row]++;
  });

  const result = groupStrokes(dirty, rowCounts, {
    width,
    height,
    colCell,
    rowGap: msg.rowGap,
    colGap: msg.colGap,
    minHeight: msg.minHeight,
    padX: msg.padX,
    padY: msg.padY,
    maxStrokes: msg.maxStrokes,
    minBandPixels: msg.minBandPixels,
  });

  return { strokes: result.strokes, truncated: result.truncated, coverage: result.coverage, width, height };
}

// Reduce the changed pixels to a handful of bounding boxes: mark a coarse cell
// grid, then flood-fill adjacent marked cells into clusters.
function diffMarkers(msg: Extract<DiffMessage, { mode: 'markers' }>): Payload {
  const a = get(msg.keyA);
  const b = get(msg.keyB);
  const width = Math.min(a.width, b.width);
  const height = Math.min(a.height, b.height);
  const cell = msg.cell;
  const cols = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  const dirty = new Uint8Array(cols * rows);
  const srcWidth = a.width;

  scanDiff(a, b, (p) => {
    const row = (((p / srcWidth) | 0) / cell) | 0;
    const col = ((p % srcWidth) / cell) | 0;
    dirty[row * cols + col] = 1;
  });

  const visited = new Uint8Array(cols * rows);
  const rects: DiffRect[] = [];
  const pad = msg.pad;

  for (let start = 0; start < dirty.length; start++) {
    if (!dirty[start] || visited[start]) continue;
    if (rects.length >= msg.maxRects) break; // safety cap for heavily-changed pages
    let minCx = start % cols;
    let maxCx = minCx;
    let minCy = (start / cols) | 0;
    let maxCy = minCy;
    const stack = [start];
    visited[start] = 1;
    while (stack.length) {
      const current = stack.pop()!;
      const cx = current % cols;
      const cy = (current / cols) | 0;
      if (cx < minCx) minCx = cx;
      if (cx > maxCx) maxCx = cx;
      if (cy < minCy) minCy = cy;
      if (cy > maxCy) maxCy = cy;
      if (cx > 0 && dirty[current - 1] && !visited[current - 1]) { visited[current - 1] = 1; stack.push(current - 1); }
      if (cx < cols - 1 && dirty[current + 1] && !visited[current + 1]) { visited[current + 1] = 1; stack.push(current + 1); }
      if (cy > 0 && dirty[current - cols] && !visited[current - cols]) { visited[current - cols] = 1; stack.push(current - cols); }
      if (cy < rows - 1 && dirty[current + cols] && !visited[current + cols]) { visited[current + cols] = 1; stack.push(current + cols); }
    }
    rects.push({
      left: Math.max(0, minCx * cell - pad),
      top: Math.max(0, minCy * cell - pad),
      right: Math.min(width, (maxCx + 1) * cell + pad),
      bottom: Math.min(height, (maxCy + 1) * cell + pad),
    });
  }

  return { rects, width, height };
}

function reply(message: DiffWorkerReply): void {
  self.postMessage(message);
}

self.onmessage = (event: MessageEvent<DiffWorkerMessage>) => {
  const msg = event.data;
  try {
    switch (msg.type) {
      case 'put':
        store(msg.key, msg.buf, msg.width, msg.height);
        return reply({ id: msg.id, ok: true });
      case 'evict':
        pageCache.delete(msg.key);
        return reply({ id: msg.id, ok: true });
      case 'reset':
        pageCache.clear();
        return reply({ id: msg.id, ok: true });
      case 'diff':
        return reply({ id: msg.id, ok: true, ...(msg.mode === 'strokes' ? diffStrokes(msg) : diffMarkers(msg)) });
      default:
        throw new Error(`Unknown message type "${(msg as { type?: unknown }).type}".`);
    }
  } catch (err) {
    reply({ id: msg?.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
