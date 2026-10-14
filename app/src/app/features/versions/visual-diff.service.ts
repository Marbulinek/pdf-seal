import { DOCUMENT } from '@angular/common';
import { Injectable, inject } from '@angular/core';
import type { PdfRect } from '../../core/models';
import { destroyDocument, isRenderingCancelled, type PdfDocument, type PdfPage, type PdfViewport } from '../../core/pdfjs-types';
import { PdfJsService } from '../../core/pdfjs.service';
import { VersionStoreService } from '../../core/version-store.service';
import { ViewerService } from '../../core/viewer.service';
import type { DiffRect, DiffWorkerReply, DiffWorkerRequest } from './diff-worker-protocol';

/** Highlighter inks, laid down with a `multiply` composite like a real pen. */
export const VISUAL_DIFF_PENS = {
  yellow: { css: '#fde047' },
  pink: { css: '#fda4af' },
  green: { css: '#86efac' },
} as const;
export type PenColor = keyof typeof VISUAL_DIFF_PENS;
export type DiffMarkStyle = 'highlight' | 'outline';

// Ceiling on the resolution the diff is *computed* at; above it the canvas is
// scaled up in CSS so zooming works without multiplying the diffing cost.
const VISUAL_DIFF_MAX_SCALE = 1.5;
const VISUAL_DIFF_CELL = 20; // outline mode: dirty-cell grid size, px
const VISUAL_DIFF_CELL_PAD = 4;
export const VISUAL_DIFF_MAX_RECTS = 50;
// Highlighter geometry in CSS px at 100% zoom (multiplied by the raster scale).
const STROKE_COL_CELL = 4;
const STROKE_ROW_GAP = 3;
const STROKE_COL_GAP = 20;
const STROKE_MIN_HEIGHT = 13;
const STROKE_PAD_X = 3;
const STROKE_PAD_Y = 2;
const STROKE_MIN_BAND_PIXELS = 6;
const MAX_STROKES = 400;
/** Past this much of the page marked, the page was re-rendered wholesale -- wash it. */
const WASH_COVERAGE = 0.6;
const INK_ALPHA = 0.45;
/** Rendered pages the worker keeps pixels for (two per page, one per side). */
const PIXEL_CACHE_LIMIT = 4;

interface Prepared {
  pageA: PdfPage | null;
  pageB: PdfPage | null;
  keyA: string;
  keyB: string;
  width: number;
  height: number;
  scale: number;
  displayViewport: PdfViewport;
}

export interface VisualResult {
  /** Marks drawn, or null when superseded/cancelled before finishing. */
  markCount: number | null;
  note: string;
}

/**
 * The imperative half of version comparison: the two pdf.js snapshot
 * documents being compared, the single-revision "View" document, the
 * off-main-thread pixel-diff worker (diff.worker.ts, which also
 * owns the rendered-page pixel cache), and painting results onto the viewer's
 * shared canvas. The VersionsStore owns every piece of UI state; this owns
 * only resources.
 */
@Injectable({ providedIn: 'root' })
export class VisualDiffService {
  private readonly document = inject(DOCUMENT);
  private readonly pdfjs = inject(PdfJsService);
  private readonly versionsDb = inject(VersionStoreService);
  private readonly viewer = inject(ViewerService);

  docA: PdfDocument | null = null;
  docB: PdfDocument | null = null;
  private pair: { sessionId: string | null; from: number | null; to: number | null } = { sessionId: null, from: null, to: null };

  revisionViewDoc: PdfDocument | null = null;

  /**
   * Bumped by every diff render entry point; anything resuming after an
   * await that finds it moved on drops its result.
   */
  generation = 0;

  private docsLoading: Promise<void> | null = null;
  private docsEpoch = 0;

  private worker: Worker | null = null;
  private workerSeq = 0;
  private readonly pending = new Map<number, { resolve: (r: DiffWorkerReply) => void; reject: (e: Error) => void }>();
  /** FIFO mirror of the keys the worker currently holds. */
  private pixelCacheKeys: string[] = [];
  /** The clean render the diff is shown against, so a pen change is a blit. */
  private baseCache: { key: string; canvas: HTMLCanvasElement } | null = null;

  // ---------------------------------------------------------------------
  // Snapshot documents
  // ---------------------------------------------------------------------

  async fetchRevisionDoc(sessionId: string | null, index: number): Promise<PdfDocument> {
    const bytes = sessionId ? await this.versionsDb.getBytes(sessionId, index) : null;
    if (!bytes) throw new Error(`Could not load snapshot for revision ${index}`);
    return this.pdfjs.openDiff(bytes);
  }

  /** Points the engine at a (new) pair; a changed pair drops the old snapshots. */
  setPair(sessionId: string | null, from: number, to: number): void {
    if (this.pair.from !== from || this.pair.to !== to || this.pair.sessionId !== sessionId) {
      this.generation++;
      this.invalidateDocs();
      this.destroyPairDocs();
      this.resetPixelCache();
    }
    this.pair = { sessionId, from, to };
  }

  hasPair(): boolean {
    return Number.isInteger(this.pair.from) && Number.isInteger(this.pair.to);
  }

  /** Abandons any snapshot load in flight (its worker is about to go away). */
  invalidateDocs(): void {
    this.docsEpoch++;
    this.docsLoading = null;
  }

  private destroyPairDocs(): void {
    destroyDocument(this.docA);
    destroyDocument(this.docB);
    this.docA = null;
    this.docB = null;
  }

  /**
   * Re-acquires whichever comparison snapshots aren't open. Single-flight and
   * the only loader: two independent loads of the same pair used to destroy
   * documents an in-flight render was still using.
   */
  ensureDocs(): Promise<void> {
    if (this.docA && this.docB) return Promise.resolve();
    if (!this.hasPair()) return Promise.resolve();
    if (this.docsLoading) return this.docsLoading;
    const loading = this.loadDocs().finally(() => {
      if (this.docsLoading === loading) this.docsLoading = null;
    });
    this.docsLoading = loading;
    return loading;
  }

  private async loadDocs(): Promise<void> {
    const epoch = this.docsEpoch;
    const { sessionId, from, to } = this.pair;
    // allSettled: one side's rejection must not orphan the other's document.
    const [resultA, resultB] = await Promise.allSettled([
      this.docA ? Promise.resolve(this.docA) : this.fetchRevisionDoc(sessionId, from!),
      this.docB ? Promise.resolve(this.docB) : this.fetchRevisionDoc(sessionId, to!),
    ]);
    const docA = resultA.status === 'fulfilled' ? resultA.value : null;
    const docB = resultB.status === 'fulfilled' ? resultB.value : null;

    if (epoch !== this.docsEpoch || sessionId !== this.pair.sessionId || from !== this.pair.from || to !== this.pair.to) {
      if (docA && docA !== this.docA) destroyDocument(docA);
      if (docB && docB !== this.docB) destroyDocument(docB);
      return;
    }

    const changed = docA !== this.docA || docB !== this.docB;
    this.docA = docA;
    this.docB = docB;
    if (changed) this.resetPixelCache();
    // Keep whichever side loaded -- the views fall back to a single doc.
    if (resultA.status === 'rejected') throw resultA.reason;
    if (resultB.status === 'rejected') throw resultB.reason;
  }

  maxPages(): number {
    return Math.max(this.docA?.numPages ?? 0, this.docB?.numPages ?? 0);
  }

  /**
   * Releases both snapshots, their cached pixels, the pixel worker and the
   * disposable pdf.js diff worker -- two whole pdf.js documents otherwise
   * stayed resident after every open/close of the diff view.
   */
  releaseAll(): void {
    this.generation++;
    destroyDocument(this.revisionViewDoc);
    this.revisionViewDoc = null;
    this.invalidateDocs();
    this.destroyPairDocs();
    this.resetPixelCache();
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.pending.forEach(({ reject }) => reject(new Error('Diff view closed.')));
    this.pending.clear();
    this.pixelCacheKeys = [];
    this.pdfjs.resetDiffWorker();
  }

  /** Clears everything for a new document (or an explicit reset). */
  resetForNewDocument(): void {
    this.generation++;
    this.invalidateDocs();
    this.destroyPairDocs();
    this.resetPixelCache();
    this.pdfjs.resetDiffWorker();
    this.pair = { sessionId: null, from: null, to: null };
  }

  closeRevisionView(): void {
    destroyDocument(this.revisionViewDoc);
    this.revisionViewDoc = null;
  }

  // ---------------------------------------------------------------------
  // Pixel-diff worker plumbing
  // ---------------------------------------------------------------------

  private getWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('./diff.worker', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<DiffWorkerReply>) => {
      const { id, ok, error } = event.data;
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      if (ok) pending.resolve(event.data);
      else pending.reject(new Error(error || 'Diff worker failed.'));
    };
    worker.onerror = () => {
      // Rejects everything in flight; the next diff spins up a fresh worker.
      this.pending.forEach(({ reject }) => reject(new Error('Diff worker crashed.')));
      this.pending.clear();
      this.pixelCacheKeys = [];
      worker.terminate();
      this.worker = null;
    };
    this.worker = worker;
    return worker;
  }

  private callWorker(message: DiffWorkerRequest, transfer: Transferable[] = []): Promise<DiffWorkerReply> {
    const id = ++this.workerSeq;
    const worker = this.getWorker();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ id, ...message }, transfer);
    });
  }

  resetPixelCache(): void {
    this.releaseBase();
    this.pixelCacheKeys = [];
    if (this.worker) this.callWorker({ type: 'reset' }).catch(() => {});
  }

  /** Makes sure the worker holds one side's pixels at `key` (rendering on a miss). */
  private async ensurePixels(key: string, page: PdfPage | null, width: number, height: number, scale: number): Promise<string> {
    const existing = this.pixelCacheKeys.indexOf(key);
    if (existing !== -1) {
      this.pixelCacheKeys.splice(existing, 1);
      this.pixelCacheKeys.push(key);
      return key;
    }
    const off = this.document.createElement('canvas');
    off.width = width;
    off.height = height;
    const offCtx = off.getContext('2d', { willReadFrequently: true });
    if (!offCtx) throw new Error('Canvas is unavailable.');
    if (page) {
      await page.render({ canvas: null, canvasContext: offCtx, viewport: page.getViewport({ scale }) }).promise;
    } else {
      // This page doesn't exist on that side -- compare against blank white.
      offCtx.fillStyle = '#ffffff';
      offCtx.fillRect(0, 0, width, height);
    }
    const pixels = offCtx.getImageData(0, 0, width, height).data;
    off.width = 0;
    off.height = 0;
    page?.cleanup();
    // Transferred, not copied.
    await this.callWorker({ type: 'put', key, buf: pixels.buffer, width, height }, [pixels.buffer]);
    if (!this.pixelCacheKeys.includes(key)) this.pixelCacheKeys.push(key);
    while (this.pixelCacheKeys.length > PIXEL_CACHE_LIMIT) {
      const evicted = this.pixelCacheKeys.shift();
      if (evicted !== undefined) this.callWorker({ type: 'evict', key: evicted }).catch(() => {});
    }
    return key;
  }

  private visualDiffScale(): number {
    return Math.min(this.viewer.scale(), VISUAL_DIFF_MAX_SCALE);
  }

  /** Page geometry, canvas sizing and both sides' pixels in the worker. */
  private async prepare(pageNum: number): Promise<Prepared | null> {
    const pageA = this.docA && pageNum <= this.docA.numPages ? await this.docA.getPage(pageNum) : null;
    const pageB = this.docB && pageNum <= this.docB.numPages ? await this.docB.getPage(pageNum) : null;
    const targetPage = pageB || pageA;
    if (!targetPage) {
      this.viewer.diffBannerText.set('Page not available in either version.');
      return null;
    }
    if (!this.viewer.userHasManuallyZoomed()) this.viewer.scale.set(1.0);

    // displayViewport is what the person sees; `scale` is what's diffed.
    const displayViewport = targetPage.getViewport({ scale: this.viewer.scale() });
    this.viewer.setViewport(displayViewport);

    const scale = this.visualDiffScale();
    const viewport = targetPage.getViewport({ scale });
    const width = Math.floor(viewport.width);
    const height = Math.floor(viewport.height);

    const keyA = await this.ensurePixels(`A:${pageNum}:${scale}`, pageA, width, height, scale);
    const keyB = await this.ensurePixels(`B:${pageNum}:${scale}`, pageB, width, height, scale);
    return { pageA, pageB, keyA, keyB, width, height, scale, displayViewport };
  }

  private releaseBase(): void {
    if (!this.baseCache) return;
    this.baseCache.canvas.width = 0;
    this.baseCache.canvas.height = 0;
    this.baseCache = null;
  }

  /** Paints `page` on the viewer canvas through a kept offscreen copy. */
  private async drawBase(page: PdfPage, side: string, pageNum: number, scale: number, width: number, height: number): Promise<boolean> {
    const ctx = this.viewer.context;
    if (!ctx) return false;
    const key = `${side}:${pageNum}:${scale}`;
    if (this.baseCache && this.baseCache.key === key) {
      ctx.drawImage(this.baseCache.canvas, 0, 0);
      return true;
    }
    const off = this.document.createElement('canvas');
    off.width = width;
    off.height = height;
    const offCtx = off.getContext('2d');
    if (!offCtx) return false;
    // The ink uses `multiply`, which needs actual paper underneath.
    offCtx.fillStyle = '#ffffff';
    offCtx.fillRect(0, 0, width, height);
    try {
      await page.render({ canvas: null, canvasContext: offCtx, viewport: page.getViewport({ scale }) }).promise;
    } catch (err) {
      off.width = 0;
      off.height = 0;
      if (isRenderingCancelled(err)) return false;
      throw err;
    } finally {
      page.cleanup();
    }
    this.releaseBase();
    this.baseCache = { key, canvas: off };
    ctx.drawImage(off, 0, 0);
    return true;
  }

  private inkStrokes(strokes: DiffRect[], pen: PenColor): void {
    const ctx = this.viewer.context;
    if (!ctx) return;
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    ctx.globalAlpha = INK_ALPHA;
    ctx.fillStyle = VISUAL_DIFF_PENS[pen].css;
    strokes.forEach((stroke) => {
      const w = stroke.right - stroke.left;
      const h = stroke.bottom - stroke.top;
      if (w <= 0 || h <= 0) return;
      roundRectPath(ctx, stroke.left, stroke.top, w, h, Math.min(h / 2, 6));
      ctx.fill();
    });
    ctx.restore();
  }

  /**
   * "Outline" marks: the target page rendered cleanly with marching-ants
   * rectangles around each changed region. markCount 0 = genuinely nothing
   * visible changed; null = superseded before finishing.
   */
  async renderOutlines(pageNum: number): Promise<VisualResult> {
    const generation = this.generation;
    const prepared = await this.prepare(pageNum);
    if (!prepared || generation !== this.generation) return { markCount: null, note: '' };
    const { pageA, pageB, keyA, keyB, width, height, scale, displayViewport } = prepared;

    const reply = await this.callWorker({
      type: 'diff',
      mode: 'markers',
      keyA,
      keyB,
      cell: VISUAL_DIFF_CELL,
      pad: VISUAL_DIFF_CELL_PAD,
      maxRects: VISUAL_DIFF_MAX_RECTS,
    });
    if (generation !== this.generation) return { markCount: null, note: '' };
    const rects = reply.rects ?? [];

    this.viewer.sizeCanvasForDiff(width, height, displayViewport);
    const painted = await this.drawBase((pageB || pageA)!, pageB ? 'B' : 'A', pageNum, scale, width, height);
    if (!painted || generation !== this.generation) return { markCount: null, note: '' };

    // Raster pixels -> PDF space, so the overlay can place them at any zoom.
    const pdfPageHeight = displayViewport.viewBox[3];
    const markers = rects.map((rect) => {
      const pdfW = (rect.right - rect.left) / scale;
      const pdfH = (rect.bottom - rect.top) / scale;
      const pdfRect: PdfRect = { x: rect.left / scale, y: pdfPageHeight - rect.top / scale - pdfH, width: pdfW, height: pdfH };
      return { rect: pdfRect, invisible: false };
    });
    this.viewer.diffMarkers.set(markers);
    // Marching ants on many markers repaint the whole canvas each frame.
    this.viewer.manyDiffMarkers.set(rects.length > 8);
    return { markCount: rects.length, note: rects.length >= VISUAL_DIFF_MAX_RECTS ? 'Showing the first marks only' : '' };
  }

  /**
   * "Highlighter" marks: changed passages swept over with a pen (grouping
   * happens in the worker -- see visual-diff-strokes.ts).
   */
  async renderHighlights(pageNum: number, pen: PenColor, missingFromLabel: string): Promise<VisualResult> {
    const generation = this.generation;
    const prepared = await this.prepare(pageNum);
    if (!prepared || generation !== this.generation) return { markCount: null, note: '' };
    const { pageA, pageB, keyA, keyB, width, height, scale, displayViewport } = prepared;
    const targetPage = (pageB || pageA)!;
    const side = pageB ? 'B' : 'A';

    // A page on only one side is trivially all changed -- say so.
    if (!pageA || !pageB) {
      this.viewer.sizeCanvasForDiff(width, height, displayViewport);
      if (!(await this.drawBase(targetPage, side, pageNum, scale, width, height))) return { markCount: null, note: '' };
      if (generation !== this.generation) return { markCount: null, note: '' };
      this.inkStrokes([{ left: 0, top: 0, right: width, bottom: height }], pen);
      return { markCount: 1, note: `This page does not exist in Version ${missingFromLabel}` };
    }

    const result = await this.callWorker({
      type: 'diff',
      mode: 'strokes',
      keyA,
      keyB,
      colCell: Math.max(1, Math.round(STROKE_COL_CELL * scale)),
      rowGap: Math.max(1, Math.round(STROKE_ROW_GAP * scale)),
      colGap: Math.max(1, Math.round(STROKE_COL_GAP * scale)),
      minHeight: Math.max(1, Math.round(STROKE_MIN_HEIGHT * scale)),
      padX: Math.round(STROKE_PAD_X * scale),
      padY: Math.round(STROKE_PAD_Y * scale),
      maxStrokes: MAX_STROKES,
      minBandPixels: STROKE_MIN_BAND_PIXELS,
    });
    if (generation !== this.generation) return { markCount: null, note: '' };

    this.viewer.sizeCanvasForDiff(width, height, displayViewport);
    if (!(await this.drawBase(targetPage, side, pageNum, scale, width, height))) return { markCount: null, note: '' };
    if (generation !== this.generation) return { markCount: null, note: '' };

    const strokes = result.strokes ?? [];
    if ((result.coverage ?? 0) > WASH_COVERAGE) {
      this.inkStrokes([{ left: 0, top: 0, right: width, bottom: height }], pen);
      return { markCount: strokes.length, note: 'Most of this page changed' };
    }
    this.inkStrokes(strokes, pen);
    return { markCount: strokes.length, note: result.truncated ? 'Showing the first marks only' : '' };
  }
}

function roundRectPath(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number): void {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  context.beginPath();
  context.moveTo(x + r, y);
  context.lineTo(x + width - r, y);
  context.arcTo(x + width, y, x + width, y + r, r);
  context.lineTo(x + width, y + height - r);
  context.arcTo(x + width, y + height, x + width - r, y + height, r);
  context.lineTo(x + r, y + height);
  context.arcTo(x, y + height, x, y + height - r, r);
  context.lineTo(x, y + r);
  context.arcTo(x, y, x + r, y, r);
  context.closePath();
}
