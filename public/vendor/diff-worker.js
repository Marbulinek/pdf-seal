/*
 * Off-main-thread pixel diffing for the visual revision diff.
 *
 * Comparing two rendered PDF pages means touching width*height*4 bytes. On the
 * main thread that froze the tab outright (a letter page at 300% zoom is ~47M
 * array accesses), and it re-ran on every page-nav click and every highlight
 * colour change. Here it runs on a worker, so the UI stays live.
 *
 * This worker also OWNS the rendered-page pixel cache. The main thread renders
 * a page once, transfers the pixels here under a key, and afterwards only ever
 * sends the key -- so a colour change re-tints from cached pixels with no
 * pdf.js render and no buffer copying at all. Transfers are zero-copy in both
 * directions, which is why the pixels live here rather than being shipped back
 * and forth per diff.
 *
 * Protocol (all messages carry an `id` echoed back on the reply):
 *   { type: 'put',   key, buf, width, height }  -> store pixels (buf transferred in)
 *   { type: 'evict', key }                      -> drop one entry
 *   { type: 'reset' }                           -> drop everything
 *   { type: 'diff',  mode: 'tint',    keyA, keyB, baseKey, highlight, alpha }
 *        -> { ok: true, buf, width, height }    (buf transferred out)
 *   { type: 'diff',  mode: 'markers', keyA, keyB, cell, pad, maxRects }
 *        -> { ok: true, rects: [{ left, top, right, bottom }, ...] }  (screen px)
 */

'use strict';

// Two pixels count as different when their channel deltas sum past this. Kept
// identical to the original main-thread implementation so the highlighted
// regions don't shift.
const DELTA_THRESHOLD = 20;

/** key -> { pixels: Uint8ClampedArray, words: Uint32Array, width, height } */
const pageCache = new Map();

function store(key, buf, width, height) {
  const pixels = new Uint8ClampedArray(buf);
  pageCache.set(key, {
    pixels,
    // A 32-bit view over the same bytes: comparing whole pixels as single
    // words lets the scan skip the (overwhelmingly common) identical pixels
    // without doing any per-channel arithmetic.
    words: new Uint32Array(buf),
    width,
    height,
  });
}

function get(key) {
  const entry = pageCache.get(key);
  if (!entry) throw new Error(`Pixel cache miss for "${key}".`);
  return entry;
}

/**
 * Walk both pages, calling `onDiff(pixelIndex)` for each differing pixel.
 * Returns the pixel count so callers can size their own buffers.
 */
function scanDiff(a, b, onDiff) {
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

// Composite the base page with a translucent tint over every changed pixel.
function diffTint(msg) {
  const a = get(msg.keyA);
  const b = get(msg.keyB);
  const base = get(msg.baseKey);
  const width = base.width;
  const height = base.height;

  const out = new Uint8ClampedArray(width * height * 4);
  // Copy the base page in one memcpy, then only overwrite what changed --
  // far cheaper than assigning four channels per pixel across the whole page.
  new Uint32Array(out.buffer).set(base.words.subarray(0, width * height));

  const alpha = msg.alpha;
  const inv = 1 - alpha;
  const hr = msg.highlight.r * alpha;
  const hg = msg.highlight.g * alpha;
  const hb = msg.highlight.b * alpha;
  const basePixels = base.pixels;

  scanDiff(a, b, (p) => {
    const i = p << 2;
    out[i] = basePixels[i] * inv + hr;
    out[i + 1] = basePixels[i + 1] * inv + hg;
    out[i + 2] = basePixels[i + 2] * inv + hb;
    out[i + 3] = 255;
  });

  return { payload: { buf: out.buffer, width, height }, transfer: [out.buffer] };
}

// Reduce the changed pixels to a handful of bounding boxes: mark a coarse cell
// grid, then flood-fill adjacent marked cells into clusters.
function diffMarkers(msg) {
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
    const row = ((p / srcWidth) | 0) / cell | 0;
    const col = (p % srcWidth) / cell | 0;
    dirty[row * cols + col] = 1;
  });

  const visited = new Uint8Array(cols * rows);
  const rects = [];
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
      const current = stack.pop();
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

  return { payload: { rects, width, height }, transfer: [] };
}

self.onmessage = (event) => {
  const msg = event.data;
  try {
    switch (msg.type) {
      case 'put':
        store(msg.key, msg.buf, msg.width, msg.height);
        self.postMessage({ id: msg.id, ok: true });
        return;
      case 'evict':
        pageCache.delete(msg.key);
        self.postMessage({ id: msg.id, ok: true });
        return;
      case 'reset':
        pageCache.clear();
        self.postMessage({ id: msg.id, ok: true });
        return;
      case 'diff': {
        const { payload, transfer } = msg.mode === 'tint' ? diffTint(msg) : diffMarkers(msg);
        self.postMessage(Object.assign({ id: msg.id, ok: true }, payload), transfer);
        return;
      }
      default:
        throw new Error(`Unknown message type "${msg.type}".`);
    }
  } catch (err) {
    self.postMessage({ id: msg && msg.id, ok: false, error: (err && err.message) || String(err) });
  }
};
