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
 * rather than a whole tinted page, so nothing large travels back.
 *
 * Protocol (all messages carry an `id` echoed back on the reply):
 *   { type: 'put',   key, buf, width, height }  -> store pixels (buf transferred in)
 *   { type: 'evict', key }                      -> drop one entry
 *   { type: 'reset' }                           -> drop everything
 *   { type: 'diff',  mode: 'strokes', keyA, keyB, ...StrokeOptions }
 *        -> { ok: true, strokes: [{ left, top, right, bottom }, ...], truncated,
 *             coverage, width, height }                              (raster px)
 *   { type: 'diff',  mode: 'markers', keyA, keyB, cell, pad, maxRects }
 *        -> { ok: true, rects: [{ left, top, right, bottom }, ...] }  (raster px)
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

// ---------------------------------------------------------------------------
// Highlighter strokes.
//
// Hand-synced copy of lib/VisualDiffStrokes.ts -- see the comment at the top
// of that file. Keep the two in sync.
// ---------------------------------------------------------------------------

// Group dirty rows into bands, merging bands separated by no more than
// `rowGap` blank rows -- that gap is what keeps the ascenders and descenders
// of one text line together, and what keeps two adjacent lines apart.
function segmentBands(rowCounts, height, rowGap, minBandPixels) {
  const bands = [];
  let current = null;
  let blankRun = 0;

  for (let row = 0; row < height; row++) {
    const count = rowCounts[row] || 0;
    if (count > 0) {
      if (current && blankRun > rowGap) {
        bands.push(current);
        current = null;
      }
      if (!current) current = { top: row, bottom: row, pixels: 0 };
      current.bottom = row;
      current.pixels += count;
      blankRun = 0;
    } else if (current) {
      blankRun++;
    }
  }
  if (current) bands.push(current);

  return bands.filter((band) => band.pixels >= minBandPixels);
}

// Flatten one band's rows into a single column occupancy list: a cell counts
// as dirty for the band if it was dirty on any of the band's rows.
function bandColumns(dirty, cols, band) {
  const occupied = new Array(cols).fill(false);
  for (let row = band.top; row <= band.bottom; row++) {
    const base = row * cols;
    for (let col = 0; col < cols; col++) {
      if (dirty[base + col]) occupied[col] = true;
    }
  }
  return occupied;
}

// Give one run the shape of a pen stroke: padded, never thinner than
// `minHeight` (grown around its own centre), clamped to the page.
function penGeometry(startCell, endCell, band, opts, width, height) {
  const left = startCell * opts.colCell - opts.padX;
  const right = (endCell + 1) * opts.colCell + opts.padX;

  let top = band.top - opts.padY;
  let bottom = band.bottom + 1 + opts.padY;
  const short = opts.minHeight - (bottom - top);
  if (short > 0) {
    const grow = short / 2;
    top -= grow;
    bottom += grow;
  }

  return {
    left: Math.max(0, Math.round(left)),
    top: Math.max(0, Math.round(top)),
    right: Math.min(width, Math.round(right)),
    bottom: Math.min(height, Math.round(bottom)),
  };
}

function groupStrokes(dirty, rowCounts, opts) {
  const { width, height, colCell } = opts;
  const cols = Math.ceil(width / colCell);
  const colGapCells = Math.max(0, Math.round(opts.colGap / colCell));

  const bands = segmentBands(rowCounts, height, opts.rowGap, opts.minBandPixels);

  const strokes = [];
  let truncated = false;

  for (const band of bands) {
    if (strokes.length >= opts.maxStrokes) {
      truncated = true;
      break;
    }

    const occupied = bandColumns(dirty, cols, band);

    // Walk the band's columns, closing off a run once more than colGapCells
    // empty cells have gone by -- words inside a phrase merge, separate
    // regions on the same line stay separate.
    let runStart = -1;
    let runEnd = -1;
    let emptyRun = 0;
    const runs = [];

    for (let col = 0; col < cols; col++) {
      if (occupied[col]) {
        if (runStart !== -1 && emptyRun > colGapCells) {
          runs.push([runStart, runEnd]);
          runStart = -1;
        }
        if (runStart === -1) runStart = col;
        runEnd = col;
        emptyRun = 0;
      } else if (runStart !== -1) {
        emptyRun++;
      }
    }
    if (runStart !== -1) runs.push([runStart, runEnd]);

    for (const run of runs) {
      if (strokes.length >= opts.maxStrokes) {
        truncated = true;
        break;
      }
      strokes.push(penGeometry(run[0], run[1], band, opts, width, height));
    }
  }

  const area = strokes.reduce((sum, s) => sum + (s.right - s.left) * (s.bottom - s.top), 0);
  const pageArea = width * height;
  const coverage = pageArea > 0 ? Math.min(1, area / pageArea) : 0;

  return { strokes, truncated, coverage };
}

// Reduce the changed pixels to highlighter strokes: one pass over the two
// pages fills a coarse occupancy grid, which groupStrokes() then bands.
function diffStrokes(msg) {
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

  return {
    payload: {
      strokes: result.strokes,
      truncated: result.truncated,
      coverage: result.coverage,
      width,
      height,
    },
    transfer: [],
  };
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
        const { payload, transfer } = msg.mode === 'strokes' ? diffStrokes(msg) : diffMarkers(msg);
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
