// Messages between VisualDiffService and the pixel-diff worker (diff.worker.ts).
// Every request carries an `id` the reply echoes back.

import type { Stroke, StrokeOptions } from './visual-diff-strokes';

/** A changed region, in raster pixels of the diffed pages. */
export type DiffRect = Stroke;

/** groupStrokes()'s options minus the page size, which the worker takes from the cached pages. */
export type StrokeDiffOptions = Omit<StrokeOptions, 'width' | 'height'>;

export type DiffWorkerRequest =
  /** Store one rendered page's RGBA pixels under `key` (`buf` is transferred in). */
  | { type: 'put'; key: string; buf: ArrayBuffer; width: number; height: number }
  /** Drop one cached page. */
  | { type: 'evict'; key: string }
  /** Drop every cached page. */
  | { type: 'reset' }
  /** Highlighter strokes over the changed text lines -> `strokes`, `truncated`, `coverage`. */
  | ({ type: 'diff'; mode: 'strokes'; keyA: string; keyB: string } & StrokeDiffOptions)
  /** Bounding boxes around clusters of changed cells -> `rects`. */
  | { type: 'diff'; mode: 'markers'; keyA: string; keyB: string; cell: number; pad: number; maxRects: number };

export type DiffWorkerMessage = DiffWorkerRequest & { id: number };

export interface DiffWorkerReply {
  id: number;
  ok: boolean;
  error?: string;
  rects?: DiffRect[];
  strokes?: DiffRect[];
  /** True when the stroke cap cut the list short. */
  truncated?: boolean;
  /** Fraction of the page the strokes cover, 0..1. */
  coverage?: number;
  width?: number;
  height?: number;
}
