import { Injectable, isDevMode } from '@angular/core';
import { destroyDocument, type PdfDocument, type PdfJsLib, type PdfWorker } from './pdfjs-types';

declare global {
  interface Window {
    /** Development builds only: the loaded pdf.js module, for docs/performance.md. */
    pdfjsLib?: PdfJsLib;
  }
}

/**
 * Where the build copies pdf.js's worker (angular.json `assets`, from
 * node_modules/pdfjs-dist/legacy/build). `/vendor` is served with an immutable cache,
 * so the URL carries the library version: an upgrade can never pair a new
 * pdf.js with a stale cached worker.
 */
const PDFJS_WORKER_PATH = '/vendor/pdfjs/pdf.worker.min.mjs';

/**
 * pdf.js's wasm decoders (JPEG 2000, JBIG2, ICC colour), copied from
 * pdfjs-dist/wasm by angular.json. Without them those images silently don't
 * render. Kept out of the immutable /vendor cache: `wasmUrl` is a bare
 * directory prefix, so it can't carry a version query like the worker does.
 */
const PDFJS_WASM_URL = '/pdfjs-wasm/';

/**
 * pdf.js comes from the `pdfjs-dist` npm package (no CDN): the library is a
 * lazy chunk of the Angular build, imported on first use (`preload()` warms
 * it up once the shell is idle), and its worker is self-hosted under /vendor.
 * Both are pdf.js's *legacy* build: the modern one calls brand-new built-ins
 * (e.g. `Map.prototype.getOrInsertComputed`) that current Chrome and Safari
 * don't ship yet; the legacy build carries polyfills for them.
 *
 * ONE pdf.js worker serves the live document (and every undo/redo target);
 * without it pdf.js spawns a dedicated worker per getDocument() call, each
 * re-parsing the 1 MB worker bundle and holding its own copy of the bytes.
 * Passed per call as `worker:` rather than GlobalWorkerOptions.workerPort:
 * workerPort routes through PDFWorker.fromPort(), and destroying any loading
 * task flags that shared port as pending-destroy, after which every later
 * getDocument() throws.
 *
 * Revision/diff snapshots get their own disposable worker, recreated on every
 * re-entry: a worker that served a render for a document destroyed mid-flight
 * can be left unable to complete later renders, and isolating that churn
 * means it can never wedge the live document view.
 */
@Injectable({ providedIn: 'root' })
export class PdfJsService {
  private libPromise: Promise<PdfJsLib> | null = null;
  private sharedWorker: PdfWorker | null = null;
  private diffWorker: PdfWorker | null = null;

  load(): Promise<PdfJsLib> {
    // The perf instrumentation (docs/performance.md) swaps window.pdfjsLib for
    // a counting proxy after load -- so always hand out the live global.
    return this.loadOnce().then((lib) => window.pdfjsLib ?? lib);
  }

  /** Starts fetching the pdf.js chunk ahead of the first document, ignoring failures. */
  preload(): void {
    this.loadOnce().catch(() => undefined);
  }

  private loadOnce(): Promise<PdfJsLib> {
    this.libPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs')
      .then((pdfjs) => {
        pdfjs.GlobalWorkerOptions.workerSrc = `${PDFJS_WORKER_PATH}?v=${encodeURIComponent(pdfjs.version)}`;
        if (isDevMode()) window.pdfjsLib = pdfjs;
        return pdfjs;
      })
      .catch((err: unknown) => {
        this.libPromise = null;
        throw new Error('pdf.js failed to load.', { cause: err });
      });
    return this.libPromise;
  }

  async sharedWorkerInstance(): Promise<PdfWorker> {
    const lib = await this.load();
    if (!this.sharedWorker || this.sharedWorker.destroyed) {
      this.sharedWorker = lib.PDFWorker.create({ name: 'pdf-seal-shared' });
    }
    return this.sharedWorker;
  }

  async diffWorkerInstance(): Promise<PdfWorker> {
    const lib = await this.load();
    if (!this.diffWorker || this.diffWorker.destroyed) {
      this.diffWorker = lib.PDFWorker.create({ name: 'pdf-seal-diff' });
    }
    return this.diffWorker;
  }

  resetDiffWorker(): void {
    if (this.diffWorker) this.diffWorker.destroy();
    this.diffWorker = null;
  }

  /** Opens `data` on the shared worker (the live document and undo/redo targets). */
  async openShared(data: ArrayBuffer | Uint8Array): Promise<PdfDocument> {
    const lib = await this.load();
    const worker = await this.sharedWorkerInstance();
    return lib.getDocument({ data, worker, wasmUrl: PDFJS_WASM_URL }).promise;
  }

  /** Opens a revision snapshot on the disposable diff worker. */
  async openDiff(data: ArrayBuffer | Uint8Array): Promise<PdfDocument> {
    const lib = await this.load();
    const worker = await this.diffWorkerInstance();
    return lib.getDocument({ data, worker, wasmUrl: PDFJS_WASM_URL }).promise;
  }

  /**
   * Opens `file` on a throwaway worker/document just long enough to read
   * getMetadata().info.Custom, then destroys both. This app's revision-chain
   * string can be multi-MB; reading it through the live document would leave
   * pdf.js caching it for that document's whole lifetime.
   */
  async readBundledChainRaw(file: Blob): Promise<string | null> {
    const lib = await this.load();
    const worker = lib.PDFWorker.create({ name: 'pdf-seal-hydrate' });
    let doc: PdfDocument | null = null;
    try {
      const arrayBuffer = await file.arrayBuffer();
      doc = await lib.getDocument({ data: arrayBuffer, worker, wasmUrl: PDFJS_WASM_URL }).promise;
      const meta = await doc.getMetadata().catch(() => null);
      // `Custom` holds the Info dictionary's non-standard keys (a Map since
      // pdf.js 5; typed as a bare `object`), which is where this app stores its chain.
      const custom = (meta?.info as { Custom?: Map<string, unknown> } | undefined)?.Custom;
      const chain = custom?.get('PdfSealRevisionChainV1') ?? custom?.get('PdfSealRevisionChain');
      return typeof chain === 'string' && chain ? chain : null;
    } catch {
      return null;
    } finally {
      destroyDocument(doc);
      worker.destroy();
    }
  }
}
