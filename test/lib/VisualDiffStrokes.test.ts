import { describe, it, expect } from 'vitest';
import { groupStrokes, type StrokeOptions } from '../../lib/VisualDiffStrokes';

const WIDTH = 200;
const HEIGHT = 100;
const COL_CELL = 4;
const COLS = Math.ceil(WIDTH / COL_CELL);

function baseOptions(overrides: Partial<StrokeOptions> = {}): StrokeOptions {
  return {
    width: WIDTH,
    height: HEIGHT,
    colCell: COL_CELL,
    rowGap: 3,
    colGap: 20,
    minHeight: 12,
    padX: 2,
    padY: 2,
    maxStrokes: 400,
    minBandPixels: 4,
    ...overrides,
  };
}

/**
 * Builds the coarse dirty grid + row counts the worker would produce, from a
 * list of changed rectangles given in page pixels.
 */
function paint(rects: Array<{ x: number; y: number; w: number; h: number }>) {
  const dirty = new Uint8Array(HEIGHT * COLS);
  const rowCounts = new Uint32Array(HEIGHT);
  for (const rect of rects) {
    for (let y = rect.y; y < rect.y + rect.h; y++) {
      for (let x = rect.x; x < rect.x + rect.w; x++) {
        dirty[y * COLS + Math.floor(x / COL_CELL)] = 1;
        rowCounts[y] += 1;
      }
    }
  }
  return { dirty, rowCounts };
}

describe('groupStrokes', () => {
  it('returns nothing for an unchanged page', () => {
    const { dirty, rowCounts } = paint([]);
    const result = groupStrokes(dirty, rowCounts, baseOptions());
    expect(result.strokes).toEqual([]);
    expect(result.truncated).toBe(false);
    expect(result.coverage).toBe(0);
  });

  it('keeps two phrases far apart on one line as separate strokes', () => {
    const { dirty, rowCounts } = paint([
      { x: 10, y: 20, w: 30, h: 8 },
      { x: 140, y: 20, w: 30, h: 8 },
    ]);
    const result = groupStrokes(dirty, rowCounts, baseOptions());

    expect(result.strokes).toHaveLength(2);
    expect(result.strokes[0].right).toBeLessThan(result.strokes[1].left);
  });

  it('merges words separated by less than colGap into one stroke', () => {
    const { dirty, rowCounts } = paint([
      { x: 10, y: 20, w: 20, h: 8 },
      { x: 42, y: 20, w: 20, h: 8 }, // 12px gap, under the 20px colGap
    ]);
    const result = groupStrokes(dirty, rowCounts, baseOptions());

    expect(result.strokes).toHaveLength(1);
    expect(result.strokes[0].left).toBeLessThanOrEqual(10);
    expect(result.strokes[0].right).toBeGreaterThanOrEqual(62);
  });

  it('merges rows within rowGap into one band and splits beyond it', () => {
    const near = paint([
      { x: 10, y: 20, w: 30, h: 4 },
      { x: 10, y: 26, w: 30, h: 4 }, // 2 blank rows, under the 3px rowGap
    ]);
    expect(groupStrokes(near.dirty, near.rowCounts, baseOptions()).strokes).toHaveLength(1);

    const far = paint([
      { x: 10, y: 20, w: 30, h: 4 },
      { x: 10, y: 40, w: 30, h: 4 }, // 16 blank rows
    ]);
    const split = groupStrokes(far.dirty, far.rowCounts, baseOptions());
    expect(split.strokes).toHaveLength(2);
    expect(split.strokes[0].bottom).toBeLessThan(split.strokes[1].top);
  });

  it('drops a speck below the noise floor', () => {
    const { dirty, rowCounts } = paint([{ x: 50, y: 50, w: 1, h: 1 }]);
    const result = groupStrokes(dirty, rowCounts, baseOptions({ minBandPixels: 4 }));
    expect(result.strokes).toEqual([]);
  });

  it('grows a thin change up to minHeight, centred on the band', () => {
    const { dirty, rowCounts } = paint([{ x: 10, y: 50, w: 40, h: 2 }]);
    const result = groupStrokes(dirty, rowCounts, baseOptions({ padY: 0, minHeight: 20 }));

    const [stroke] = result.strokes;
    expect(stroke.bottom - stroke.top).toBe(20);
    // Band spans rows 50..51, so its centre (51) stays the stroke's centre.
    expect((stroke.top + stroke.bottom) / 2).toBe(51);
  });

  it('clamps strokes to the page bounds', () => {
    const { dirty, rowCounts } = paint([{ x: 0, y: 0, w: WIDTH, h: 6 }]);
    const [stroke] = groupStrokes(dirty, rowCounts, baseOptions()).strokes;

    expect(stroke.left).toBe(0);
    expect(stroke.top).toBe(0);
    expect(stroke.right).toBe(WIDTH);
    expect(stroke.bottom).toBeLessThanOrEqual(HEIGHT);
  });

  it('stops at maxStrokes and reports truncation', () => {
    const rects = [];
    for (let i = 0; i < 10; i++) rects.push({ x: 10, y: i * 10, w: 20, h: 3 });
    const { dirty, rowCounts } = paint(rects);

    const result = groupStrokes(dirty, rowCounts, baseOptions({ maxStrokes: 3 }));
    expect(result.strokes).toHaveLength(3);
    expect(result.truncated).toBe(true);
  });

  it('truncates mid-band when a single line holds more runs than the cap', () => {
    const rects = [];
    for (let i = 0; i < 5; i++) rects.push({ x: i * 40, y: 20, w: 8, h: 6 });
    const { dirty, rowCounts } = paint(rects);

    const result = groupStrokes(dirty, rowCounts, baseOptions({ maxStrokes: 2 }));
    expect(result.strokes).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it('reports near-total coverage when the whole page changed', () => {
    const { dirty, rowCounts } = paint([{ x: 0, y: 0, w: WIDTH, h: HEIGHT }]);
    const result = groupStrokes(dirty, rowCounts, baseOptions());

    expect(result.strokes).toHaveLength(1);
    expect(result.coverage).toBeGreaterThan(0.9);
    expect(result.coverage).toBeLessThanOrEqual(1);
  });

  it('reports no coverage for a zero-sized page', () => {
    const result = groupStrokes(new Uint8Array(0), new Uint32Array(0), baseOptions({ width: 0, height: 0 }));
    expect(result.coverage).toBe(0);
  });
});
