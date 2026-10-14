import { computed } from '@angular/core';
import { patchState, signalStore, withComputed, withMethods, withState } from '@ngrx/signals';
import type {
  DocAnnotation,
  DocField,
  DocMetadata,
  DocStamp,
  DocumentOverviewData,
} from './models';
import type { PdfDocument } from './pdfjs-types';

/** A field as held in the store: a server field plus a stable client-side id. */
export interface StoreField extends DocField {
  /** Stable for the field's life in this session -- survives renames and moves. */
  uid: string;
}

export interface DocumentState {
  activeFile: File | null;
  pdfDoc: PdfDocument | null;

  /**
   * Working field list. Add/edit/remove in the Signatures panel change this
   * locally (no server round trip); the diff against `fieldsBaseline` is what
   * "Apply changes" sends as one batch. Updated immutably.
   */
  fields: StoreField[];
  /** Last field state actually confirmed by the server. */
  fieldsBaseline: StoreField[];

  // Metadata/overview summary from the full /api/info (fetched lazily).
  documentMeta: DocMetadata | null;
  documentRawInfo: Record<string, unknown> | null;
  documentStamps: DocStamp[];
  documentAnnotations: DocAnnotation[];
  documentOverview: DocumentOverviewData | null;
  /** The File the above were loaded for (reference equality with activeFile). */
  documentMetaLoadedFor: File | null;

  // Local version history bookkeeping (see VersionStoreService).
  documentSessionId: string | null;
  documentRevisionCount: number;
  /**
   * The versionKey of the stored version currently shown. An index alone is
   * ambiguous -- undo/redo followed by a new edit can reuse an index for
   * different bytes -- so anything naming "this exact stored version" uses this.
   */
  activeVersionKey: string | null;

  isDocumentUpdating: boolean;
  /** Set for the duration of any processNewFile() call. */
  documentLoadInFlight: boolean;

  loadingOverlayVisible: boolean;
  loadingProgress: number;
}

const initialState: DocumentState = {
  activeFile: null,
  pdfDoc: null,
  fields: [],
  fieldsBaseline: [],
  documentMeta: null,
  documentRawInfo: null,
  documentStamps: [],
  documentAnnotations: [],
  documentOverview: null,
  documentMetaLoadedFor: null,
  documentSessionId: null,
  documentRevisionCount: 0,
  activeVersionKey: null,
  isDocumentUpdating: false,
  documentLoadInFlight: false,
  loadingOverlayVisible: false,
  loadingProgress: 0,
};

let uidSeq = 0;
export function nextFieldUid(): string {
  uidSeq += 1;
  return `f${uidSeq}`;
}

/** Gives server fields a client uid and stamps their baseline name. */
export function intakeFields(fields: DocField[] | null | undefined): StoreField[] {
  return (fields || []).map((f) => ({ ...f, uid: nextFieldUid(), __baselineName: f.name }));
}

/** Deep-enough copy for history snapshots and the baseline. */
export function cloneFields(fields: readonly StoreField[] | null | undefined): StoreField[] {
  return (fields || []).map((f) => ({
    uid: f.uid,
    name: f.name,
    __baselineName: f.__baselineName,
    type: f.type,
    required: !!f.required,
    readOnly: !!f.readOnly,
    multiline: f.type === 'TextField' && !!f.multiline,
    tooltip: f.tooltip,
    page: f.page,
    signed: f.signed === true,
    // Immutable on the client; shared by reference so Field Details and radio
    // markers survive Discard and undo/redo.
    raw: f.raw,
    extraWidgets: f.extraWidgets,
    objectRefs: f.objectRefs,
    rect: f.rect ? { x: f.rect.x, y: f.rect.y, width: f.rect.width, height: f.rect.height } : null,
  }));
}

/**
 * The open document's state. Pure state + small updaters, so every feature
 * can depend on it without injection cycles; orchestration (load, apply,
 * undo...) lives in DocumentService.
 */
export const DocumentStore = signalStore(
  { providedIn: 'root' },
  withState(initialState),
  withComputed(({ pdfDoc, activeFile }) => ({
    hasDocument: computed(() => pdfDoc() !== null),
    activeFileName: computed(() => activeFile()?.name ?? ''),
  })),
  withMethods((store) => ({
    update(patch: Partial<DocumentState>): void {
      patchState(store, patch);
    },
    setFields(fields: StoreField[]): void {
      patchState(store, { fields });
    },
    updateField(uid: string, changes: Partial<StoreField>): void {
      patchState(store, (s) => ({ fields: s.fields.map((f) => (f.uid === uid ? { ...f, ...changes } : f)) }));
    },
    /** Replaces both the working fields and the baseline with server truth. */
    resetFieldsFromServer(fields: DocField[] | null | undefined): void {
      const intake = intakeFields(fields);
      patchState(store, { fields: intake, fieldsBaseline: cloneFields(intake) });
    },
    clearMeta(): void {
      patchState(store, {
        documentMeta: null,
        documentRawInfo: null,
        documentStamps: [],
        documentAnnotations: [],
        documentOverview: null,
      });
    },
    setLoadingProgress(percent: number): void {
      patchState(store, { loadingProgress: Math.max(0, Math.min(100, percent)) });
    },
  })),
);

export type DocumentStore = InstanceType<typeof DocumentStore>;
