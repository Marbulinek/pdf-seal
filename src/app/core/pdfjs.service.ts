import { DOCUMENT } from '@angular/common';
import { Injectable, inject } from '@angular/core';
import type { PdfDocument, PdfJsLib, PdfWorker } from './pdfjs-types';

declare global {
  interface Window {
    pdfjsLib?: PdfJsLib;
  }
}

const PDFJS_SRC = '/vendor/pdfjs/pdf.min.js';
const PDFJS_WORKER_SRC = '/vendor/pdfjs/pdf.worker.min.js';

/**
 * pdf.js stays self-hosted under public/vendor (no CDN) and is loaded on
 * first use -- index.html preloads it so the request is already in flight.
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
  private readonly document = inject(DOCUMENT);
  private libPromise: Promise<PdfJsLib> | null = null;
  private sharedWorker: PdfWorker | null = null;
  private diffWorker: PdfWorker | null = null;

  load(): Promise<PdfJsLib> {
    // The perf instrumentation (docs/performance.md) swaps window.pdfjsLib for
    // a counting proxy after load -- so always hand out the live global.
    return this.loadOnce().then((lib) => window.pdfjsLib ?? lib);
  }

  private loadOnce(): Promise<PdfJsLib> {
    if (this.libPromise) return this.libPromise;
    this.libPromise = new Promise<PdfJsLib>((resolve, reject) => {
      const done = () => {
        const lib = window.pdfjsLib;
        if (!lib) {
          reject(new Error('pdf.js failed to load.'));
          return;
        }
        lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_SRC;
        resolve(lib);
      };
      if (window.pdfjsLib) {
        done();
        return;
      }
      const script = this.document.createElement('script');
      script.src = PDFJS_SRC;
      script.async = true;
      script.onload = done;
      script.onerror = () => reject(new Error('pdf.js failed to load.'));
      this.document.head.appendChild(script);
    }).catch((err) => {
      this.libPromise = null;
      throw err;
    });
    return this.libPromise;
  }

  async sharedWorkerInstance(): Promise<PdfWorker> {
    const lib = await this.load();
    if (!this.sharedWorker || this.sharedWorker.destroyed) {
      this.sharedWorker = new lib.PDFWorker({ name: 'pdf-seal-shared' });
    }
    return this.sharedWorker;
  }

  async diffWorkerInstance(): Promise<PdfWorker> {
    const lib = await this.load();
    if (!this.diffWorker || this.diffWorker.destroyed) {
      this.diffWorker = new lib.PDFWorker({ name: 'pdf-seal-diff' });
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
    return lib.getDocument({ data, worker }).promise;
  }

  /** Opens a revision snapshot on the disposable diff worker. */
  async openDiff(data: ArrayBuffer | Uint8Array): Promise<PdfDocument> {
    const lib = await this.load();
    const worker = await this.diffWorkerInstance();
    return lib.getDocument({ data, worker }).promise;
  }

  /**
   * Opens `file` on a throwaway worker/document just long enough to read
   * getMetadata().info.Custom, then destroys both. This app's revision-chain
   * string can be multi-MB; reading it through the live document would leave
   * pdf.js caching it for that document's whole lifetime.
   */
  async readBundledChainRaw(file: Blob): Promise<string | null> {
    const lib = await this.load();
    const worker = new lib.PDFWorker({ name: 'pdf-seal-hydrate' });
    let doc: PdfDocument | null = null;
    try {
      const arrayBuffer = await file.arrayBuffer();
      doc = await lib.getDocument({ data: arrayBuffer, worker }).promise;
      const meta = await doc.getMetadata().catch(() => null);
      const custom = meta && meta.info && meta.info.Custom;
      return (custom && (custom.PdfSealRevisionChainV1 || custom.PdfSealRevisionChain)) || null;
    } catch {
      return null;
    } finally {
      if (doc) doc.destroy();
      worker.destroy();
    }
  }
}
