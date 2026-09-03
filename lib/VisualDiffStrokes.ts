// Turns the raw per-pixel differences between two rendered PDF pages into a
// handful of highlighter-pen strokes.
//
// The visual revision diff used to tint every changed pixel individually,
// which on real documents reads as speckle: anti-aliased glyph edges, a
// half-pixel baseline shift and a re-encoded image all light up separately,
// and nothing about the result says "this line changed". Instead the changed
// pixels are reduced here to text-line bands, and each band to the horizontal
// runs of changed content inside it -- one stroke per changed phrase, the way
// somebody would actually mark up a printout.
//
// public/vendor/diff-worker.js inlines a copy of groupStrokes() (the app has
// no frontend build step to import from here, and this runs inside a Web
// Worker); this module exists so the banding logic has unit coverage. Keep
// the two in sync by hand if either changes.

export interface StrokeOptions {
  /** Page raster size, in diff pixels. */
  width: number;
  height: number;
  /** Width of one column cell in the dirty grid, in diff pixels. */
  colCell: number;
  /** Vertical gap (px) between dirty rows that still counts as one band. */
  rowGap: number;
  /** Horizontal gap (px) between runs that still counts as one stroke. */
  colGap: number;
  /** Minimum stroke height (px) -- a lone changed underscore still reads as a swept line. */
  minHeight: number;
  padX: number;
  padY: number;
  /** Safety cap for pathologically changed pages. */
  maxStrokes: number;
  /** Bands with fewer changed pixels than this are dropped as noise. */
  minBandPixels: number;
}

export interface Stroke {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface StrokeResult {
  strokes: Stroke[];
  /** True when maxStrokes cut the list short. */
  truncated: boolean;
  /** Fraction of the page the strokes cover, 0..1. */
  coverage: number;
}

interface Band {
  top: number;
  bottom: number;
  pixels: number;
}

/**
 * Group dirty rows into bands, merging bands separated by no more than
 * `rowGap` blank rows -- that gap is what keeps the ascenders and descenders
 * of one text line together, and what keeps two adjacent lines apart.
 */
function segmentBands(rowCounts: ArrayLike<number>, height: number, rowGap: number, minBandPixels: number): Band[] {
  const bands: Band[] = [];
  let current: Band | null = null;
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

/**
 * Flatten one band's rows into a single column occupancy list: a cell counts
 * as dirty for the band if it was dirty on any of the band's rows.
 */
function bandColumns(dirty: ArrayLike<number>, cols: number, band: Band): boolean[] {
  const occupied = new Array<boolean>(cols).fill(false);
  for (let row = band.top; row <= band.bottom; row++) {
    const base = row * cols;
    for (let col = 0; col < cols; col++) {
      if (dirty[base + col]) occupied[col] = true;
    }
  }
  return occupied;
}

/**
 * Reduce changed pixels to highlighter strokes.
 *
 * `dirty` is a coarse `height x ceil(width / colCell)` occupancy grid (one
 * byte per cell, non-zero when any changed pixel fell in it) and `rowCounts`
 * holds the number of changed pixels on each row. Both come from a single
 * pass over the two pages -- see diffStrokes() in the worker.
 */
export function groupStrokes(
  dirty: ArrayLike<number>,
  rowCounts: ArrayLike<number>,
  opts: StrokeOptions,
): StrokeResult {
  const { width, height, colCell } = opts;
  const cols = Math.ceil(width / colCell);
  const colGapCells = Math.max(0, Math.round(opts.colGap / colCell));

  const bands = segmentBands(rowCounts, height, opts.rowGap, opts.minBandPixels);

  const strokes: Stroke[] = [];
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
    const runs: Array<[number, number]> = [];

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

    for (const [start, end] of runs) {
      if (strokes.length >= opts.maxStrokes) {
        truncated = true;
        break;
      }
      strokes.push(penGeometry(start, end, band, opts, width, height));
    }
  }

  const area = strokes.reduce((sum, s) => sum + (s.right - s.left) * (s.bottom - s.top), 0);
  const pageArea = width * height;
  const coverage = pageArea > 0 ? Math.min(1, area / pageArea) : 0;

  return { strokes, truncated, coverage };
}

/**
 * Give one run the shape of a pen stroke: padded, never thinner than
 * `minHeight` (grown around its own centre), clamped to the page.
 */
function penGeometry(
  startCell: number,
  endCell: number,
  band: Band,
  opts: StrokeOptions,
  width: number,
  height: number,
): Stroke {
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
