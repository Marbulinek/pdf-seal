import { InjectionToken, type Signal } from '@angular/core';
import type { ElementVersionLike } from './version-history';
import type { DocumentSnapshot, ProcessFileOptions } from './document.service';
import type { CertificateReport } from './models';
import type { PdfDocument } from './pdfjs-types';

// The document life-cycle and the four feature stores call into each other:
// loading a file resets every section, while a section's action (Apply,
// certificate modify, undo) reloads the file. These narrow port interfaces --
// bound to the concrete stores in app.config.ts -- keep those call paths
// explicit and break the dependency (and type-inference) cycle between them.

export type DiffTabId = 'overview' | 'details' | 'visual';
export type StatusTone = 'loading' | 'success' | 'error' | 'info';

export interface VersionsListSnapshot {
  revisions: unknown[] | null;
  loadedFor: string | null;
}

export interface DocumentsPort {
  processNewFile(file: File, options?: ProcessFileOptions): Promise<void>;
  handleApiUpdate(endpoint: string, formData: FormData, successMessage?: string): Promise<boolean>;
  ensureRevisionHydration(): Promise<void>;
  captureSnapshot(): DocumentSnapshot;
  openHistoryTargetDoc(file: File): Promise<PdfDocument | null>;
  applySnapshot(snapshot: DocumentSnapshot, loadedDoc: PdfDocument | null): Promise<void>;
}

export interface SignaturesPort {
  readonly activeFieldUid: Signal<string | null>;
  readonly pendingCount: Signal<number>;
  deselect(): void;
  clearPendingField(): void;
  resetHistory(): void;
  resetForNewDocument(): void;
  dropStaleRedoEntries(fromIndex: number): void;
  cancelRectEdit(): void;
  commitSnapshot(snapshot: DocumentSnapshot): void;
  setStatus(message: string, type?: StatusTone): void;
  applyPending(): Promise<boolean>;
  showFieldOnDocument(fieldName: string): Promise<void>;
  selectByName(fieldName: string): void;
}

export interface OverviewPort {
  loadIfNeeded(): Promise<void>;
  closeSheet(): void;
  clearDiagnosticOrigin(): void;
}

export interface VersionsPort {
  invalidateList(): void;
  resetDiffState(): void;
  loadIfNeeded(): Promise<void>;
  snapshotList(): VersionsListSnapshot;
  restoreList(snapshot: VersionsListSnapshot): void;
  loadedSummariesFor(sessionId: string | null): Promise<ElementVersionLike[]>;
  openDiffWhenReady(from: number, to: number, tab: DiffTabId, term: string | null): Promise<void>;
  suspend(): void;
  resume(): Promise<void>;
}

export interface CertificatesPort {
  readonly reportForActiveFile: Signal<CertificateReport | null>;
  reset(): void;
  loadIfNeeded(): Promise<void>;
  focusForField(fieldName: string): Promise<void>;
  closeCertificateSheet(): void;
  closeModifySheet(): void;
  closeTimelineSheet(): void;
}

export interface SharePort {
  resetForChangedDocument(): void;
}

export interface ExportPort {
  bundleRevisionHistoryPdf(onProgress?: (loaded: number, total: number) => void): Promise<Blob>;
}

export const DOCUMENTS = new InjectionToken<DocumentsPort>('DocumentsPort');
export const SIGNATURES = new InjectionToken<SignaturesPort>('SignaturesPort');
export const OVERVIEW = new InjectionToken<OverviewPort>('OverviewPort');
export const VERSIONS = new InjectionToken<VersionsPort>('VersionsPort');
export const CERTIFICATES = new InjectionToken<CertificatesPort>('CertificatesPort');
export const SHARE = new InjectionToken<SharePort>('SharePort');
export const EXPORT = new InjectionToken<ExportPort>('ExportPort');
