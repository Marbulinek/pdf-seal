import { DOCUMENT } from '@angular/common';
import { Injectable, inject } from '@angular/core';
import { classifySaveAgainstBlob, planVersionStorage } from './version-history';
import { ApiService, type UploadRequest } from './api.service';
import { DocumentStore, cloneFields, type StoreField } from './document.store';
import type { DocField, InfoFieldsResponse } from './models';
import { NotificationService } from './notification.service';
import { destroyDocument, type PdfDocument } from './pdfjs-types';
import { PdfJsService } from './pdfjs.service';
import { CERTIFICATES, OVERVIEW, SHARE, SIGNATURES, VERSIONS, type DocumentsPort } from './ports';
import { UiService } from './ui.service';
import { analyzeBase64Pdf } from './util/base64';
import { runAtIdle } from './util/dom';
import { createSessionId, createUuid } from './util/ids';
import { lazyInject } from './util/lazy';
import { VersionStoreService } from './version-store.service';
import { ViewerService } from './viewer.service';

export interface ProcessFileOptions {
  /** Keep the current page (an edit of the same document). */
  preservePage?: boolean;
  /** Append to the current version session instead of starting a new one. */
  isEdit?: boolean;
  /** A P2P-received file: never upload it just to read fields. */
  skipServerInfo?: boolean;
  transferredFields?: DocField[];
  /** Fields the caller already has (apply-changes' withFields response). */
  knownFields?: DocField[] | null;
}

/** A field-history step: the File reference plus the small bits of state that aren't in IndexedDB. */
export interface DocumentSnapshot {
  file: File | null;
  pageNum: number;
  documentFields: StoreField[];
  fieldsBaseline: StoreField[];
  documentSessionId: string | null;
  documentRevisionCount: number;
  activeVersionKey: string | null;
}

interface HydrationTicket {
  sessionId: string;
  file: File;
  promise: Promise<void>;
  start(): void;
}

declare global {
  interface Window {
    /** Probed by the browser extension (extension/background.js) before it posts `pdfseal:import`. */
    processNewFile?: (file: File) => Promise<void>;
  }
}

/**
 * Loading, replacing, closing and re-saving the open document. Owns the
 * life-cycle rules that span every section: a new file supersedes every
 * outstanding load, a failed replacement rolls back to the previous document,
 * and local version history is written (and cleaned up) alongside.
 */
@Injectable({ providedIn: 'root' })
export class DocumentService implements DocumentsPort {
  private readonly document = inject(DOCUMENT);
  private readonly store = inject(DocumentStore);
  private readonly api = inject(ApiService);
  private readonly pdfjs = inject(PdfJsService);
  private readonly versionsDb = inject(VersionStoreService);
  private readonly viewer = inject(ViewerService);
  private readonly ui = inject(UiService);
  private readonly notifications = inject(NotificationService);

  private readonly signatures = lazyInject(SIGNATURES);
  private readonly overview = lazyInject(OVERVIEW);
  private readonly versions = lazyInject(VERSIONS);
  private readonly certificates = lazyInject(CERTIFICATES);
  private readonly share = lazyInject(SHARE);

  /**
   * A new file selection supersedes every outstanding parse/upload for the
   * previous one, so an older, slower request never applies over a newer one.
   */
  private documentLoadGeneration = 0;
  private activeDocumentFieldsRequest: UploadRequest<InfoFieldsResponse> | null = null;
  /** The current document's embedded-chain hydration (see scheduleEmbeddedRevisionHydration). */
  private revisionHydration: HydrationTicket | null = null;

  constructor() {
    // Best-effort: clear the active session's local history when the tab is
    // closed. e.persisted means back-forward cache -- the tab may come back.
    this.document.defaultView?.addEventListener('pagehide', (e: PageTransitionEvent) => {
      if (e.persisted) return;
      const sessionId = this.store.documentSessionId();
      if (sessionId) this.versionsDb.clearSession(sessionId).catch(() => {});
    });

    // Browser extension hand-off (extension/background.js). The extension
    // recognises a PDF Seal tab by this global before posting its import, so
    // it is part of that contract -- keep it. Messages: same-window, same-origin only.
    const view = this.document.defaultView;
    if (view) view.processNewFile = (file: File) => this.processNewFile(file);
    this.document.defaultView?.addEventListener('message', (event: MessageEvent) => {
      const msg = event.data as { type?: string; base64?: unknown; name?: unknown } | null;
      if (event.source !== window || event.origin !== location.origin || msg?.type !== 'pdfseal:import') return;
      try {
        const result = analyzeBase64Pdf(String(msg.base64));
        if (!result.isPdf) return;
        const name = typeof msg.name === 'string' && msg.name ? msg.name : 'document.pdf';
        this.processNewFile(new File([result.bytes as BlobPart], name, { type: 'application/pdf' }));
      } catch {
        /* not valid Base64 */
      }
    });
  }

  isPdfFile(file: File | null | undefined): boolean {
    return !!file && (file.type === 'application/pdf' || /\.pdf$/i.test(file.name || ''));
  }

  handleDroppedFile(file: File): void {
    if (!this.isPdfFile(file)) {
      this.notifications.show('Please drop a PDF file.', 'error');
      return;
    }
    this.processNewFile(file);
  }

  private isSectionOpen(section: 'metadata' | 'revisions' | 'certificates'): boolean {
    return this.ui.activeSection() === section;
  }

  // ---------------------------------------------------------------------
  // Field scan (runs in parallel with pdf.js parsing the first page)
  // ---------------------------------------------------------------------

  private loadDocumentFields(file: File, onProgress: (percent: number) => void): UploadRequest<InfoFieldsResponse> {
    const formData = new FormData();
    formData.append('pdfDocument', file);
    formData.append('fieldsOnly', 'true');
    return this.api.upload<InfoFieldsResponse>('/api/info', formData, {
      responseType: 'json',
      onProgress: (loaded, total) => onProgress((loaded / total) * 45),
      errorMessage: (status) => `Failed to read document (status ${status}).`,
      networkError: 'Network error while reading document.',
    });
  }

  // ---------------------------------------------------------------------
  // Embedded revision-chain hydration (deferred until after first paint)
  // ---------------------------------------------------------------------

  /**
   * Schedules the current document's hydration and registers it so
   * ensureRevisionHydration() can force it to run right away. The idle
   * callback and a direct ensure race to start() -- whichever comes first wins.
   */
  private scheduleEmbeddedRevisionHydration(file: File, sessionId: string): void {
    let started = false;
    let resolveStart!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      resolveStart = resolve;
    });

    const stillCurrent = () => sessionId === this.store.documentSessionId() && this.store.activeFile() === file;

    const run = async () => {
      if (!stillCurrent()) return;
      try {
        const hydrated = await this.versionsDb.hydrateRevisions(sessionId, file);
        if (!stillCurrent()) return;
        if (hydrated) {
          this.store.update({ documentRevisionCount: hydrated.count, activeVersionKey: hydrated.versionKey });
        }
      } catch {
        if (!stillCurrent()) return;
        // A partial hydration can't be trusted -- leave local storage holding
        // just the current file at index 1 (beginWrite drops anything above).
        const versionKey = createSessionId();
        const recoveryBuffer = await file.arrayBuffer();
        await this.versionsDb
          .beginWrite(sessionId, 1, recoveryBuffer, {
            source: 'upload',
            saveKind: 'initial',
            versionKey,
            storage: 'full',
            baseKey: null,
            byteLength: recoveryBuffer.byteLength,
          })
          .catch(this.versionsDb.reportWriteFailure);
        this.store.update({ documentRevisionCount: 1, activeVersionKey: versionKey });
      }
      if (!stillCurrent()) return;
      this.versions().invalidateList();
      if (this.isSectionOpen('revisions')) this.versions().loadIfNeeded();
    };

    const ticket: HydrationTicket = {
      sessionId,
      file,
      promise: startedPromise.then(run),
      start() {
        if (started) return;
        started = true;
        resolveStart();
      },
    };
    this.revisionHydration = ticket;

    // Yield at least one turn so the canvas paint isn't delayed by parsing.
    setTimeout(() => runAtIdle(() => ticket.start(), 1000, 0), 0);
  }

  /**
   * Forces the current document's scheduled hydration to run now and waits
   * for it. Callers that read the local version store (Apply, certificate
   * modify, export bundling, the tour's Versions step) await this first.
   */
  async ensureRevisionHydration(): Promise<void> {
    const ticket = this.revisionHydration;
    if (!ticket || ticket.sessionId !== this.store.documentSessionId() || ticket.file !== this.store.activeFile()) return;
    ticket.start();
    await ticket.promise;
  }

  // ---------------------------------------------------------------------
  // processNewFile
  // ---------------------------------------------------------------------

  async processNewFile(file: File, options: ProcessFileOptions = {}): Promise<void> {
    const store = this.store;
    const viewer = this.viewer;
    this.overview().clearDiagnosticOrigin();
    const loadGeneration = ++this.documentLoadGeneration;
    const isCurrentLoad = () => loadGeneration === this.documentLoadGeneration;
    // Set for every call; cleared only once *this* generation concludes while current.
    store.update({ documentLoadInFlight: true });
    this.activeDocumentFieldsRequest?.abort();
    this.activeDocumentFieldsRequest = null;

    const preservePage = !!options.preservePage;
    const skipServerInfo = !!options.skipServerInfo;
    const transferredFields = Array.isArray(options.transferredFields) ? options.transferredFields : [];
    const knownFields = Array.isArray(options.knownFields) ? options.knownFields : null;
    const currentPage = viewer.pageNum();
    const targetPage = preservePage && Number.isInteger(currentPage) && currentPage > 0 ? currentPage : 1;

    if (viewer.diffActive()) viewer.exitDiffViewMode();
    const previousFile = store.activeFile();
    const documentChanged = !!(previousFile && previousFile !== file);
    // Snapshot the currently-loaded (valid) document so a failed upload can
    // fall back to it instead of leaving stale pages next to reset panels.
    const previousPdfDoc = store.pdfDoc();
    const previous = previousPdfDoc
      ? {
          file: previousFile,
          pdfDoc: previousPdfDoc,
          pageNum: currentPage,
          fields: store.fields(),
          fieldsBaseline: store.fieldsBaseline(),
          documentMeta: store.documentMeta(),
          documentRawInfo: store.documentRawInfo(),
          documentStamps: store.documentStamps(),
          documentAnnotations: store.documentAnnotations(),
          documentOverview: store.documentOverview(),
          documentMetaLoadedFor: store.documentMetaLoadedFor(),
          versionsList: this.versions().snapshotList(),
          documentSessionId: store.documentSessionId(),
          documentRevisionCount: store.documentRevisionCount(),
          activeVersionKey: store.activeVersionKey(),
        }
      : null;
    // The pdf.js document this load replaces. Kept alive until the load
    // commits or fails, so a rollback always has an intact document.
    const outgoing: PdfDocument | null = previous?.pdfDoc ?? null;
    store.update({ activeFile: file });
    if (documentChanged) this.share().resetForChangedDocument();
    if (documentChanged && !preservePage) viewer.userHasManuallyZoomed.set(false);

    // Immediate feedback before the first asynchronous step.
    viewer.containerVisible.set(true);
    store.update({ loadingOverlayVisible: true, loadingProgress: 0 });

    // Read once; shared by classification, the version write and pdf.js
    // (which detaches it, so nothing after that point can read it again).
    const arrayBuffer = await file.arrayBuffer();
    if (!isCurrentLoad()) return;

    const isEdit = !!options.isEdit;
    let pendingRevisionCleanup: { type: 'session'; sessionId: string } | { type: 'index'; sessionId: string; index: number } | null = null;
    let pendingVersionWrite: Promise<void> | null = null;
    const cleanupPendingRevision = () => {
      if (pendingRevisionCleanup?.type !== 'session') return;
      const sessionId = pendingRevisionCleanup.sessionId;
      const cleanup = () => this.versionsDb.clearSession(sessionId).catch(() => {});
      // A clear issued before the put finishes could let the put land after it.
      if (pendingVersionWrite) pendingVersionWrite.then(cleanup, cleanup);
      else cleanup();
    };
    // The previous session is dropped only once this load succeeds.
    let previousSessionIdToClear: string | null = null;
    const sessionId = store.documentSessionId();
    if (isEdit && sessionId) {
      const currBytes = new Uint8Array(arrayBuffer);
      const saveKind = await classifySaveAgainstBlob(previous?.file ?? null, currBytes);
      if (saveKind === 'identical') {
        pendingRevisionCleanup = null;
      } else {
        const index = store.documentRevisionCount() + 1;
        store.update({ documentRevisionCount: index });
        const versionKey = createSessionId();
        pendingRevisionCleanup = { type: 'index', sessionId, index };
        this.signatures().dropStaleRedoEntries(index);

        // A delta needs its base's write confirmed landed.
        const lastWrite = this.versionsDb.lastVersionWriteCompletion;
        const priorWriteLanded = lastWrite ? await lastWrite.then(() => true, () => false) : true;
        const prior =
          priorWriteLanded && previous?.file
            ? { versionKey: store.activeVersionKey() ?? '', byteLength: previous.file.size }
            : null;
        const plan = planVersionStorage(prior, saveKind, currBytes);

        store.update({ activeVersionKey: versionKey });
        ({ completion: pendingVersionWrite } = await this.versionsDb.startWrite(sessionId, index, plan.data.buffer as ArrayBuffer, {
          source: 'edit',
          saveKind,
          versionKey,
          storage: plan.storage,
          baseKey: plan.baseKey,
          byteLength: currBytes.byteLength,
        }));
      }
    } else {
      previousSessionIdToClear = sessionId;
      const newSessionId = createUuid();
      const versionKey = createSessionId();
      store.update({ documentSessionId: newSessionId, documentRevisionCount: 1, activeVersionKey: versionKey });
      pendingRevisionCleanup = { type: 'session', sessionId: newSessionId };
      // Always a full copy -- a fresh session has nothing to delta against.
      ({ completion: pendingVersionWrite } = await this.versionsDb.startWrite(newSessionId, 1, arrayBuffer, {
        source: 'upload',
        saveKind: 'initial',
        versionKey,
        storage: 'full',
        baseKey: null,
        byteLength: arrayBuffer.byteLength,
      }));
    }

    if (!isCurrentLoad()) {
      cleanupPendingRevision();
      return;
    }

    this.versions().invalidateList();
    this.versions().resetDiffState();
    if (!pendingVersionWrite && this.isSectionOpen('revisions')) this.versions().loadIfNeeded();

    this.certificates().reset();
    if (this.isSectionOpen('certificates')) this.certificates().loadIfNeeded();

    // A brand new document means any pending placement/selection is stale.
    this.resetPanelsForNewDocument();
    if (skipServerInfo || knownFields) {
      store.resetFieldsFromServer(skipServerInfo ? transferredFields : knownFields);
    }

    let nextPdfDoc: PdfDocument | null = null;
    let adopted = false;

    try {
      let progressHighWaterMark = 0;
      const setLoadingProgress = (percent: number) => {
        progressHighWaterMark = Math.max(progressHighWaterMark, percent);
        store.setLoadingProgress(progressHighWaterMark);
      };
      let fieldsRequestError: unknown = null;
      const fieldsRequest = skipServerInfo || knownFields ? null : this.loadDocumentFields(file, setLoadingProgress);
      this.activeDocumentFieldsRequest = fieldsRequest;
      const fieldsPromise = fieldsRequest
        ? fieldsRequest.promise.catch((error: unknown) => {
            // Keep the rejection observed even if pdf.js fails first.
            fieldsRequestError = error;
            return null;
          })
        : null;

      setLoadingProgress(50);
      store.clearMeta();
      store.update({ documentMetaLoadedFor: null });

      if (!isCurrentLoad()) {
        cleanupPendingRevision();
        return;
      }
      setLoadingProgress(65);
      nextPdfDoc = await this.pdfjs.openShared(arrayBuffer);
      if (!isCurrentLoad()) {
        destroyDocument(nextPdfDoc);
        cleanupPendingRevision();
        return;
      }
      setLoadingProgress(80);

      // Adopt the new document, but keep `outgoing` alive until the commit point.
      store.update({ pdfDoc: nextPdfDoc });
      adopted = true;

      if (this.isSectionOpen('metadata')) this.overview().loadIfNeeded();

      viewer.pageNum.set(Math.min(Math.max(targetPage, 1), nextPdfDoc.numPages));
      viewer.indicatorCount.set(nextPdfDoc.numPages);
      await viewer.renderPage(viewer.pageNum());
      setLoadingProgress(100);
      store.update({ loadingOverlayVisible: false });

      // Let the first page appear before waiting for the server-side field scan.
      if (fieldsPromise) {
        const data = await fieldsPromise;
        if (!isCurrentLoad()) {
          if (outgoing && outgoing !== nextPdfDoc) destroyDocument(outgoing);
          return;
        }
        if (this.activeDocumentFieldsRequest === fieldsRequest) this.activeDocumentFieldsRequest = null;
        if (fieldsRequestError) throw fieldsRequestError;
        store.resetFieldsFromServer(data?.fields || []);
      }

      // Commit point: the outgoing document's resources can be released.
      if (outgoing && outgoing !== nextPdfDoc) destroyDocument(outgoing);

      // A genuinely new upload clears undo/redo -- only now it has committed.
      if (!isEdit) this.signatures().resetHistory();

      if (pendingVersionWrite) {
        await pendingVersionWrite.catch(this.versionsDb.reportWriteFailure);
        if (!isCurrentLoad()) return;
        if (this.isSectionOpen('revisions')) this.versions().loadIfNeeded();
      }

      // A fresh upload may carry the app's own revision chain -- import it
      // off the critical preview path.
      const newSessionId = store.documentSessionId();
      if (!isEdit && newSessionId) this.scheduleEmbeddedRevisionHydration(file, newSessionId);

      if (previousSessionIdToClear) this.versionsDb.clearSession(previousSessionIdToClear).catch(() => {});

      store.update({ documentLoadInFlight: false });
    } catch (err) {
      if (!isCurrentLoad()) {
        if (adopted) {
          if (outgoing && outgoing !== nextPdfDoc) destroyDocument(outgoing);
        } else if (nextPdfDoc) {
          destroyDocument(nextPdfDoc);
        }
        return;
      }
      if (this.activeDocumentFieldsRequest) {
        this.activeDocumentFieldsRequest.abort();
        this.activeDocumentFieldsRequest = null;
      }
      store.update({ loadingOverlayVisible: false });
      if (pendingVersionWrite) await pendingVersionWrite.catch(() => {});
      const cleanup = pendingRevisionCleanup as typeof pendingRevisionCleanup;
      if (cleanup) {
        if (cleanup.type === 'session') this.versionsDb.clearSession(cleanup.sessionId).catch(() => {});
        else this.versionsDb.deleteVersion(cleanup.sessionId, cleanup.index).catch(() => {});
      }
      if (adopted && nextPdfDoc && nextPdfDoc !== previous?.pdfDoc) destroyDocument(nextPdfDoc);

      if (previous) {
        // Roll back to the last valid document.
        store.update({
          activeFile: previous.file,
          pdfDoc: previous.pdfDoc,
          fields: previous.fields,
          fieldsBaseline: previous.fieldsBaseline,
          documentMeta: previous.documentMeta,
          documentRawInfo: previous.documentRawInfo,
          documentStamps: previous.documentStamps,
          documentAnnotations: previous.documentAnnotations,
          documentOverview: previous.documentOverview,
          documentMetaLoadedFor: previous.documentMetaLoadedFor,
          documentSessionId: previous.documentSessionId,
          documentRevisionCount: previous.documentRevisionCount,
          activeVersionKey: previous.activeVersionKey,
        });
        this.versions().restoreList(previous.versionsList);
        viewer.pageNum.set(previous.pageNum);
        viewer.indicatorCount.set(previous.pdfDoc.numPages);
        await viewer.renderPage(previous.pageNum);
        if (this.isSectionOpen('revisions')) this.versions().loadIfNeeded();
        if (this.isSectionOpen('metadata')) this.overview().loadIfNeeded();
      } else {
        store.update({
          activeFile: null,
          pdfDoc: null,
          fields: [],
          fieldsBaseline: [],
          documentMetaLoadedFor: null,
          documentSessionId: null,
          documentRevisionCount: 0,
          activeVersionKey: null,
        });
        store.clearMeta();
        this.signatures().resetHistory();
        viewer.containerVisible.set(false);
        if (this.isSectionOpen('revisions')) this.versions().loadIfNeeded();
      }
      store.update({ documentLoadInFlight: false });
      this.notifications.show('Error processing PDF: ' + errorMessage(err), 'error');
    }
  }

  /**
   * Resets the per-document UI (selection, placement, forms, metadata). Field
   * history itself is NOT reset here -- a new upload clears it only once it
   * commits, and an Apply/certificate-modify reload never clears it.
   */
  resetPanelsForNewDocument(): void {
    this.signatures().resetForNewDocument();
    this.store.clearMeta();
    this.overview().closeSheet();
  }

  /**
   * Discards the loaded document with no replacement: every section's
   * "loaded for this file" cache is cleared and each repaints its empty state.
   */
  closeActiveDocument(): void {
    const store = this.store;
    if (!store.activeFile() && !store.pdfDoc()) return;
    const sessionToClear = store.documentSessionId();
    destroyDocument(store.pdfDoc());
    store.update({
      activeFile: null,
      pdfDoc: null,
      fields: [],
      fieldsBaseline: [],
      documentMetaLoadedFor: null,
      documentSessionId: null,
      documentRevisionCount: 0,
      activeVersionKey: null,
    });
    this.signatures().resetHistory();
    this.resetPanelsForNewDocument();
    this.versions().resetDiffState();
    this.versions().invalidateList();
    this.certificates().reset();
    this.viewer.containerVisible.set(false);
    this.viewer.viewport.set(null);
    this.ui.goToSection('metadata');
    this.overview().loadIfNeeded();
    this.versions().loadIfNeeded();
    this.certificates().loadIfNeeded();
    if (sessionToClear) this.versionsDb.clearSession(sessionToClear).catch(() => {});
  }

  /**
   * Sends `formData` to `endpoint` and replaces the active file with the PDF
   * it returns. Resolves whether the update succeeded.
   */
  async handleApiUpdate(endpoint: string, formData: FormData, successMessage = 'Update successful.'): Promise<boolean> {
    const loadingToast = this.notifications.show('Processing document…', 'loading', 0);
    this.store.update({ isDocumentUpdating: true });
    const activeName = this.store.activeFile()?.name || 'document.pdf';

    try {
      const response = await this.api.fetch(endpoint, { method: 'POST', body: formData });
      if (!response.ok) throw new Error(await this.api.extractErrorMessage(response));

      const contentType = response.headers.get('content-type') || '';
      let updatedFile: File;
      let knownFields: DocField[] | null = null;

      if (contentType.startsWith('multipart/form-data')) {
        // apply-changes' withFields response: the PDF and its recomputed field
        // list in one body, so processNewFile needn't re-scan the file.
        const blob = await response.blob();
        const parsedForm = await new Response(blob, { headers: { 'Content-Type': contentType } }).formData();
        const pdfPart = parsedForm.get('pdfDocument');
        if (!(pdfPart instanceof Blob)) throw new Error('Could not read the server response.');
        updatedFile = new File([pdfPart], activeName, { type: 'application/pdf' });
        try {
          const fieldsPart = parsedForm.get('fields');
          if (typeof fieldsPart === 'string') knownFields = JSON.parse(fieldsPart) as DocField[];
        } catch {
          // Fall back to the normal fields request rather than failing the apply.
          knownFields = null;
        }
      } else {
        const blob = await response.blob();
        updatedFile = new File([blob], activeName, { type: 'application/pdf' });
      }

      await this.processNewFile(updatedFile, { preservePage: true, isEdit: true, knownFields });
      loadingToast.dismiss();
      this.notifications.show(successMessage, 'success');
      return true;
    } catch (err) {
      loadingToast.dismiss();
      this.notifications.show(`Error: ${errorMessage(err)}`, 'error');
      return false;
    } finally {
      this.store.update({ isDocumentUpdating: false });
    }
  }

  // ---------------------------------------------------------------------
  // Undo/redo across a document boundary
  // ---------------------------------------------------------------------

  captureSnapshot(): DocumentSnapshot {
    return {
      file: this.store.activeFile(),
      pageNum: this.viewer.pageNum(),
      documentFields: cloneFields(this.store.fields()),
      fieldsBaseline: cloneFields(this.store.fieldsBaseline()),
      documentSessionId: this.store.documentSessionId(),
      documentRevisionCount: this.store.documentRevisionCount(),
      activeVersionKey: this.store.activeVersionKey(),
    };
  }

  /**
   * Opens `file` for an undo/redo that crosses a document boundary. Null if a
   * newer load started meanwhile -- the caller must not commit to the swap.
   */
  async openHistoryTargetDoc(file: File): Promise<PdfDocument | null> {
    const loadGeneration = ++this.documentLoadGeneration;
    const arrayBuffer = await file.arrayBuffer();
    const doc = await this.pdfjs.openShared(arrayBuffer);
    if (loadGeneration !== this.documentLoadGeneration) {
      destroyDocument(doc);
      return null;
    }
    return doc;
  }

  /**
   * Restores a history snapshot. Same document: only the staged-field state
   * changes (session id/revision count reflect since-refreshed work and are
   * kept). Different document: `loadedDoc` (opened by the caller first) is
   * swapped in and every section re-derives from it.
   */
  async applySnapshot(snapshot: DocumentSnapshot, loadedDoc: PdfDocument | null): Promise<void> {
    const store = this.store;
    const signatures = this.signatures();
    if (snapshot.file === store.activeFile()) {
      this.viewer.pageNum.set(snapshot.pageNum);
      store.update({ fields: snapshot.documentFields, fieldsBaseline: snapshot.fieldsBaseline });
      signatures.deselect();
      signatures.clearPendingField();
      return;
    }

    const outgoingDoc = store.pdfDoc();
    store.update({
      activeFile: snapshot.file,
      pdfDoc: loadedDoc,
      fields: snapshot.documentFields,
      fieldsBaseline: snapshot.fieldsBaseline,
      documentSessionId: snapshot.documentSessionId,
      documentRevisionCount: snapshot.documentRevisionCount,
      activeVersionKey: snapshot.activeVersionKey,
    });
    signatures.deselect();
    signatures.clearPendingField();

    if (this.viewer.diffActive()) this.viewer.exitDiffViewMode();
    this.versions().resetDiffState();

    const pageCount = loadedDoc?.numPages ?? 1;
    this.viewer.pageNum.set(Math.min(Math.max(snapshot.pageNum, 1), pageCount));
    this.viewer.indicatorCount.set(pageCount);
    await this.viewer.renderPage(this.viewer.pageNum());

    destroyDocument(outgoingDoc);

    store.clearMeta();
    store.update({ documentMetaLoadedFor: null });
    if (this.isSectionOpen('metadata')) this.overview().loadIfNeeded();

    this.versions().invalidateList();
    if (this.isSectionOpen('revisions')) this.versions().loadIfNeeded();

    this.certificates().reset();
    if (this.isSectionOpen('certificates')) this.certificates().loadIfNeeded();

    this.share().resetForChangedDocument();
    signatures.cancelRectEdit();
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return String(err);
}

