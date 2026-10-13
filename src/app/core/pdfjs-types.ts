// The subset of the pdf.js 3.x API this app uses. pdf.js ships as a vendored
// UMD bundle (public/vendor/pdfjs), so these are hand-written rather than
// imported from pdfjs-dist.

export interface PdfViewport {
  width: number;
  height: number;
  scale: number;
  /** [x1, y1, x2, y2] of the page in PDF space -- viewBox[3] is the page height. */
  viewBox: number[];
  convertToViewportRectangle(rect: number[]): number[];
}

/** A viewport tagged with the per-axis scale the overlay maths uses. */
export interface ScaledViewport extends PdfViewport {
  scaleX: number;
  scaleY: number;
}

export interface PdfRenderTask {
  promise: Promise<void>;
  cancel(): void;
}

export interface PdfRenderParams {
  canvasContext: CanvasRenderingContext2D;
  viewport: PdfViewport;
  transform?: number[];
}

export interface PdfPage {
  getViewport(params: { scale: number }): PdfViewport;
  render(params: PdfRenderParams): PdfRenderTask;
  cleanup(): void;
}

export interface PdfMetadataResult {
  info?: { Custom?: Record<string, string> };
}

export interface PdfDocument {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPage>;
  getMetadata(): Promise<PdfMetadataResult>;
  destroy(): void;
}

export interface PdfWorker {
  destroyed: boolean;
  destroy(): void;
}

export interface PdfLoadingTask {
  promise: Promise<PdfDocument>;
}

export interface PdfJsLib {
  GlobalWorkerOptions: { workerSrc: string };
  PDFWorker: new (params: { name: string }) => PdfWorker;
  getDocument(params: { data: ArrayBuffer | Uint8Array; worker: PdfWorker }): PdfLoadingTask;
}

export function isRenderingCancelled(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { name?: string }).name === 'RenderingCancelledException';
}
