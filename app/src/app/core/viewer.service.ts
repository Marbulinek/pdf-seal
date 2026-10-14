import { Injectable, inject, signal } from '@angular/core';
import { DocumentStore } from './document.store';
import { flashElement } from './util/dom';
import type { PdfRect } from './models';
import {
  isRenderingCancelled,
  type PdfDocument,
  type PdfPage,
  type PdfRenderTask,
  type PdfViewport,
  type ScaledViewport,
} from './pdfjs-types';

/** CSS px square sampled under a field overlay's centred icon. */
const ICON_SAMPLE_SIZE = 24;

/** Mean relative luminance of RGBA pixels below 50%. */
export function isDarkPixels(rgba: Uint8ClampedArray): boolean {
  let sum = 0;
  for (let i = 0; i < rgba.length; i += 4) sum += 0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2];
  return rgba.length > 0 && sum / (rgba.length / 4) < 127.5;
}

export interface ScreenRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A marker drawn over the page while the viewer shows a diff/snapshot. */
export interface DiffMarker {
  rect: PdfRect;
  invisible: boolean;
}

/** Hooks the Versions feature registers so zoom/paging re-render the right thing. */
export interface ViewerDiffDelegate {
  /** A single-revision snapshot is open in the viewer. */
  hasRevisionView(): boolean;
  revisionViewPage(): number;
  revisionViewPageCount(): number;
  renderRevisionViewPage(num: number): Promise<void>;
  /** Re-renders whatever diff/preview is up (after a zoom change). */
  redrawDiff(): void;
  diffPrev(): void;
  diffNext(): void;
  exitDiffViewMode(): void;
}

/**
 * Ceiling on the shared canvas's backing-store resolution. Past it the canvas
 * rasterizes at a capped resolution and is scaled up in CSS instead.
 */
const MAX_CANVAS_DIMENSION = 4096;
/** px; smaller than any real layout -- below it the viewer isn't laid out yet. */
export const MIN_MEASURABLE_VIEWER_WIDTH = 40;
const PDF_CONTAINER_BORDER = 1; // px, must match .pdf-container's border-width

/**
 * The document viewer on the left. It owns the one shared canvas that shows
 * either the live document, a single revision snapshot, or a revision diff --
 * there is no second, parallel PDF viewer. `diffActive` switches it into the
 * read-only display mode the Versions feature drives.
 */
@Injectable({ providedIn: 'root' })
export class ViewerService {
  private readonly store = inject(DocumentStore);

  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private scrollEl: HTMLElement | null = null;
  private overlayEl: HTMLElement | null = null;
  private diffDelegate: ViewerDiffDelegate | null = null;

  private currentRenderTask: PdfRenderTask | null = null;
  /**
   * Bumped on every renderPage(); checked after each await so a stale call
   * (rapid paging) never overlays the newer viewport with older fields.
   */
  private renderPageGeneration = 0;

  readonly pageNum = signal(1);
  readonly scale = signal(1);
  readonly userHasManuallyZoomed = signal(false);
  readonly viewport = signal<ScaledViewport | null>(null);
  readonly isPanning = signal(false);

  // The page indicator / prev-next state. Set explicitly by whichever view is
  // on the canvas (live document, snapshot, diff) -- they each count pages
  // differently.
  readonly indicatorPage = signal(0);
  readonly indicatorCount = signal(0);
  readonly prevDisabled = signal(true);
  readonly nextDisabled = signal(true);

  /** The canvas container is shown (vs. the empty-state drop zone). */
  readonly containerVisible = signal(false);

  readonly diffActive = signal(false);
  readonly diffBannerText = signal('Comparing versions');
  readonly diffMarkers = signal<DiffMarker[]>([]);
  readonly manyDiffMarkers = signal(false);
  /** Bumped when the live overlays should be flashed/scrolled for a selector. */
  readonly overlayRenderTick = signal(0);

  attach(canvas: HTMLCanvasElement, scrollEl: HTMLElement, overlayEl: HTMLElement): void {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.scrollEl = scrollEl;
    this.overlayEl = overlayEl;
  }

  detach(): void {
    this.canvas = null;
    this.ctx = null;
    this.scrollEl = null;
    this.overlayEl = null;
  }

  setDiffDelegate(delegate: ViewerDiffDelegate | null): void {
    this.diffDelegate = delegate;
  }

  get canvasElement(): HTMLCanvasElement | null {
    return this.canvas;
  }

  get context(): CanvasRenderingContext2D | null {
    return this.ctx;
  }

  get overlayElement(): HTMLElement | null {
    return this.overlayEl;
  }

  get scrollElement(): HTMLElement | null {
    return this.scrollEl;
  }

  canvasSize(): { width: number; height: number } {
    return { width: this.canvas?.width ?? 0, height: this.canvas?.height ?? 0 };
  }

  canvasClientRect(): DOMRect | null {
    return this.canvas?.getBoundingClientRect() ?? null;
  }

  /** Whether the rendered page is dark where a box's centred icon sits. */
  isDarkUnder(box: ScreenRect, viewport: ScaledViewport): boolean {
    const canvas = this.canvas;
    const ctx = this.ctx;
    if (!canvas || !ctx || this.diffActive() || !viewport.width) return false;
    const r = canvas.width / viewport.width; // != 1 when the render was overscaled down
    const w = Math.min(box.width, ICON_SAMPLE_SIZE) * r;
    const h = Math.min(box.height, ICON_SAMPLE_SIZE) * r;
    const x = (box.left + box.width / 2) * r - w / 2;
    const y = (box.top + box.height / 2) * r - h / 2;
    if (w < 1 || h < 1) return false;
    return isDarkPixels(ctx.getImageData(Math.round(x), Math.round(y), Math.round(w), Math.round(h)).data);
  }

  /**
   * .pdf-container wraps the canvas in a 1px border, which adds 2px on top of
   * the canvas's own size -- subtracted here so a 100% fit doesn't trigger a
   * phantom scrollbar.
   */
  computeAvailViewerSize(): { width: number; height: number } {
    const chrome = 8 + PDF_CONTAINER_BORDER * 2;
    return {
      width: Math.max(1, (this.scrollEl?.clientWidth ?? 0) - chrome),
      height: Math.max(1, (this.scrollEl?.clientHeight ?? 0) - chrome),
    };
  }

  /**
   * Scale at which `page` fills the viewer edge-to-edge horizontally. Null when
   * the viewer has no usable width yet -- callers leave the scale alone and the
   * ResizeObserver refits once a real width shows up.
   */
  computeFitScale(page: PdfPage): number | null {
    const avail = this.computeAvailViewerSize();
    if (avail.width < MIN_MEASURABLE_VIEWER_WIDTH) return null;
    const baseViewport = page.getViewport({ scale: 1 });
    return Math.max(0.1, avail.width / baseViewport.width);
  }

  /** Fits the page unless the user zoomed by hand; returns the scaled viewport. */
  fittedViewport(page: PdfPage): ScaledViewport {
    if (!this.userHasManuallyZoomed()) {
      const fitScale = this.computeFitScale(page);
      if (fitScale !== null) this.scale.set(fitScale);
    }
    return this.scaled(page.getViewport({ scale: this.scale() }), this.scale());
  }

  scaled(viewport: PdfViewport, scale: number): ScaledViewport {
    const v = viewport as ScaledViewport;
    v.scaleX = scale;
    v.scaleY = scale;
    return v;
  }

  setViewport(viewport: PdfViewport): void {
    const v = viewport as ScaledViewport;
    if (v.scaleX === undefined) v.scaleX = v.scale;
    if (v.scaleY === undefined) v.scaleY = v.scaleX;
    this.viewport.set(v);
  }

  /** Renders `num` of the live document and lays its fields over it. */
  async renderPage(num: number): Promise<void> {
    const pdfDoc = this.store.pdfDoc();
    if (!pdfDoc) return;
    const generation = ++this.renderPageGeneration;

    const page = await pdfDoc.getPage(num);
    // A diff view can claim the shared canvas while getPage() is pending.
    if (this.diffActive() || generation !== this.renderPageGeneration) return;

    const viewport = this.fittedViewport(page);
    const rendered = await this.renderToCanvas(page, viewport);
    // A snapshot or diff may have claimed the canvas while this rendered.
    if (this.diffActive() || !rendered || generation !== this.renderPageGeneration) return;

    this.viewport.set(viewport);
    this.indicatorPage.set(num);
    this.indicatorCount.set(pdfDoc.numPages);
    this.prevDisabled.set(num <= 1);
    this.nextDisabled.set(num >= pdfDoc.numPages);
    this.overlayRenderTick.update((n) => n + 1);
  }

  /** Renders the current page of the live document. */
  renderCurrentPage(): Promise<void> {
    return this.renderPage(this.pageNum());
  }

  async goToPage(num: number): Promise<void> {
    this.pageNum.set(num);
    await this.renderPage(num);
  }

  cancelRender(): void {
    if (this.currentRenderTask) {
      this.currentRenderTask.cancel();
      this.currentRenderTask = null;
    }
  }

  /** Paints `page` onto the shared canvas. Resolves false if cancelled. */
  async renderToCanvas(page: PdfPage, viewport: PdfViewport): Promise<boolean> {
    const canvas = this.canvas;
    const ctx = this.ctx;
    if (!canvas || !ctx) return false;
    this.cancelRender();

    const overscale = Math.max(1, viewport.width / MAX_CANVAS_DIMENSION, viewport.height / MAX_CANVAS_DIMENSION);
    const renderViewport = overscale > 1 ? page.getViewport({ scale: viewport.scale / overscale }) : viewport;

    canvas.height = renderViewport.height;
    canvas.width = renderViewport.width;
    if (overscale > 1) {
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
    } else {
      // The visual diff scales the canvas up in CSS -- clear that so a normal
      // render presents at its natural pixel size.
      canvas.style.width = '';
      canvas.style.height = '';
    }

    const renderTask = page.render({ canvas: null, canvasContext: ctx, viewport: renderViewport });
    this.currentRenderTask = renderTask;
    try {
      await renderTask.promise;
    } catch (err) {
      if (isRenderingCancelled(err)) return false;
      throw err;
    } finally {
      if (this.currentRenderTask === renderTask) this.currentRenderTask = null;
      // pdf.js holds decoded images/fonts until told to let go; in `finally`
      // so a cancelled render releases them too.
      page.cleanup();
    }
    return true;
  }

  /** Points the canvas at a diff raster presented at the zoomed size. */
  sizeCanvasForDiff(width: number, height: number, displayViewport: PdfViewport): void {
    this.cancelRender();
    this.diffMarkers.set([]);
    if (!this.canvas) return;
    this.canvas.width = width;
    this.canvas.height = height;
    this.canvas.style.width = `${Math.floor(displayViewport.width)}px`;
    this.canvas.style.height = `${Math.floor(displayViewport.height)}px`;
  }

  // ---- PDF <-> screen geometry (scaleY falls back to scaleX) ----

  screenRectToPdf(screenLeft: number, screenTop: number, screenWidth: number, screenHeight: number): PdfRect {
    const viewport = this.viewport()!;
    const scaleX = viewport.scaleX ?? viewport.scale;
    const scaleY = viewport.scaleY ?? scaleX;
    const pdfPageHeight = viewport.viewBox[3];
    const width = screenWidth / scaleX;
    const height = screenHeight / scaleY;
    return { x: screenLeft / scaleX, y: pdfPageHeight - screenTop / scaleY - height, width, height };
  }

  pdfRectToScreen(pdfRect: PdfRect, viewport: ScaledViewport | null = this.viewport()): ScreenRect {
    if (!viewport) return { left: 0, top: 0, width: 0, height: 0 };
    const scaleX = viewport.scaleX ?? viewport.scale;
    const scaleY = viewport.scaleY ?? scaleX;
    const pdfPageHeight = viewport.viewBox[3];
    return {
      left: pdfRect.x * scaleX,
      top: (pdfPageHeight - pdfRect.y - pdfRect.height) * scaleY,
      width: pdfRect.width * scaleX,
      height: pdfRect.height * scaleY,
    };
  }

  // ---- Zoom / paging (dispatching to whatever is on the canvas) ----

  /**
   * The canvas shows the live document, a revision snapshot, or a diff;
   * anything that changes the scale re-renders whichever is up.
   */
  redraw(): void {
    const delegate = this.diffDelegate;
    if (delegate?.hasRevisionView()) {
      delegate.renderRevisionViewPage(delegate.revisionViewPage());
      return;
    }
    if (this.diffActive()) {
      delegate?.redrawDiff();
      return;
    }
    if (this.store.pdfDoc()) this.renderPage(this.pageNum());
  }

  /** The zoom readout doubles as the "back to fit" control. */
  resetZoomToFit(): void {
    if (!this.store.pdfDoc() && !this.diffDelegate?.hasRevisionView()) return;
    this.userHasManuallyZoomed.set(false);
    this.redraw();
  }

  changeScale(delta: number): void {
    if (!this.store.pdfDoc() && !this.diffDelegate?.hasRevisionView()) return;
    this.userHasManuallyZoomed.set(true);
    this.scale.update((s) => Math.max(0.5, Math.min(3.0, s + delta)));
    this.redraw();
  }

  prev(): void {
    const delegate = this.diffDelegate;
    if (delegate?.hasRevisionView()) {
      const page = delegate.revisionViewPage();
      if (page > 1) delegate.renderRevisionViewPage(page - 1);
      return;
    }
    if (this.diffActive()) {
      delegate?.diffPrev();
      return;
    }
    if (this.pageNum() <= 1 || !this.store.pdfDoc()) return;
    this.pageNum.update((n) => n - 1);
    this.renderPage(this.pageNum());
  }

  next(): void {
    const delegate = this.diffDelegate;
    if (delegate?.hasRevisionView()) {
      const page = delegate.revisionViewPage();
      if (page < delegate.revisionViewPageCount()) delegate.renderRevisionViewPage(page + 1);
      return;
    }
    if (this.diffActive()) {
      delegate?.diffNext();
      return;
    }
    const pdfDoc = this.store.pdfDoc();
    if (!pdfDoc || this.pageNum() >= pdfDoc.numPages) return;
    this.pageNum.update((n) => n + 1);
    this.renderPage(this.pageNum());
  }

  exitDiffViewMode(): void {
    this.diffDelegate?.exitDiffViewMode();
  }

  /** Clears diff state and hands the canvas back to the live document. */
  leaveDiffMode(): void {
    this.diffActive.set(false);
    this.diffMarkers.set([]);
    this.manyDiffMarkers.set(false);
    if (this.store.pdfDoc()) {
      this.renderPage(this.pageNum());
    } else {
      this.containerVisible.set(false);
    }
  }

  /** Swaps the viewer into the read-only diff/snapshot mode. */
  enterDiffMode(): void {
    this.diffActive.set(true);
    // Kill any live-document render still in flight on the shared canvas.
    this.cancelRender();
    this.diffMarkers.set([]);
    this.prevDisabled.set(true);
    this.nextDisabled.set(true);
    this.containerVisible.set(true);
  }

  /** Shows `pageIndex` (0-based) of the live document. */
  async showPage(pageIndex: number | null): Promise<void> {
    if (pageIndex === null || !Number.isInteger(pageIndex) || pageIndex + 1 === this.pageNum()) return;
    await this.goToPage(pageIndex + 1);
  }

  /** Resolves after the next two animation frames -- i.e. once Angular has rendered. */
  afterRender(): Promise<void> {
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  }

  /** Shows `pageIndex` (0-based) and pulses the element matching `selector` once drawn. */
  async goToPageAndFlash(pageIndex: number | null, selector: string | null): Promise<void> {
    try {
      await this.showPage(pageIndex);
    } catch {
      return;
    }
    if (!selector) return;
    await this.afterRender();
    flashElement(document.querySelector(selector));
  }

  /** For the tour and certificate cross-links: the live document's page count. */
  pageCount(doc: PdfDocument | null = this.store.pdfDoc()): number {
    return doc?.numPages ?? 0;
  }
}
