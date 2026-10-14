// The pdf.js API (the `pdfjs-dist` npm package, legacy build) under the names
// this app uses. Type-only: the library itself is a lazy chunk loaded by PdfJsService.
import type { PDFDocumentProxy, PDFPageProxy, PDFWorker, PageViewport, RenderTask } from 'pdfjs-dist/legacy/build/pdf.mjs';

export type PdfJsLib = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
export type PdfDocument = PDFDocumentProxy;
export type PdfPage = PDFPageProxy;
export type PdfViewport = PageViewport;
export type PdfWorker = PDFWorker;
export type PdfRenderTask = RenderTask;

/** A viewport tagged with the per-axis scale the overlay maths uses. */
export interface ScaledViewport extends PdfViewport {
  scaleX: number;
  scaleY: number;
}

/** Releases a document and its loading task (pdf.js 5+ has no `PDFDocumentProxy.destroy()`). */
export function destroyDocument(doc: PdfDocument | null | undefined): void {
  void doc?.loadingTask.destroy();
}

/** `rect` ([x1, y1, x2, y2] in PDF space) in viewport coordinates. */
export function toViewportRectangle(viewport: PdfViewport, rect: readonly number[]): [number, number, number, number] {
  const [x1, y1] = viewport.convertToViewportPoint(rect[0], rect[1]);
  const [x2, y2] = viewport.convertToViewportPoint(rect[2], rect[3]);
  return [x1, y1, x2, y2];
}

export function isRenderingCancelled(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { name?: string }).name === 'RenderingCancelledException';
}
