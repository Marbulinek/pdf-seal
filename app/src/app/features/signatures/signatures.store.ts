import { computed, effect, inject, linkedSignal } from '@angular/core';
import {
  patchState,
  signalStore,
  withComputed,
  withHooks,
  withLinkedState,
  withMethods,
  withProps,
  withState,
} from '@ngrx/signals';
import { errorMessage, type DocumentSnapshot } from '../../core/document.service';
import { DocumentStore, nextFieldUid, type StoreField } from '../../core/document.store';
import { FIELD_TYPE_CONFIG, isEditableField } from '../../core/field-rules';
import type { PdfRect } from '../../core/models';
import { NotificationService } from '../../core/notification.service';
import { SettingsService } from '../../core/settings.service';
import { UiService } from '../../core/ui.service';
import { lazyInject } from '../../core/util/lazy';
import { DOCUMENTS } from '../../core/ports';
import { ViewerService } from '../../core/viewer.service';
import {
  buildPendingChangesDetails,
  computeFieldOps,
  describePendingFieldChanges,
  isFieldStaged,
  serializeOps,
} from './field-ops';

/** Undo keeps at most this many steps. */
export const FIELD_HISTORY_LIMIT = 10;

export type StatusType = 'loading' | 'success' | 'error' | 'info';

interface SignaturesState {
  /** The selected field (Edit sheet + drag/resize), by stable uid. */
  activeFieldUid: string | null;
  /** Waiting for the user's next click on the PDF to drop a new field. */
  isPlacing: boolean;
  // The "Add signature" form.
  addName: string;
  addWidth: number;
  addHeight: number;
  addRequired: boolean;
  /** Short-lived status line under the Add form (also used by Versions errors). */
  status: { message: string; type: StatusType } | null;
  undoStack: DocumentSnapshot[];
  redoStack: DocumentSnapshot[];
  /** An async undo/redo is running -- guards against overlapping clicks. */
  historyBusy: boolean;
  /** Which exit animation the bar plays on its next hide. */
  pendingHideReason: 'apply' | 'discard' | null;
  /** The Edit sheet slides away (keeping the selection) during a template capture drag. */
  editSheetSuppressed: boolean;
}

const initialState: SignaturesState = {
  activeFieldUid: null,
  isPlacing: false,
  addName: '',
  addWidth: FIELD_TYPE_CONFIG.signature.defaultWidth,
  addHeight: FIELD_TYPE_CONFIG.signature.defaultHeight,
  addRequired: false,
  status: null,
  undoStack: [],
  redoStack: [],
  historyBusy: false,
  pendingHideReason: null,
  editSheetSuppressed: false,
};

/**
 * Signature-field editing: selection, click-to-place, staged add/move/
 * resize/rename/remove, undo/redo, and the one-batch Apply.
 */
export const SignaturesStore = signalStore(
  { providedIn: 'root' },
  withState(initialState),
  withProps(() => ({
    _doc: inject(DocumentStore),
    _viewer: inject(ViewerService),
    _ui: inject(UiService),
    _settings: inject(SettingsService),
    _notifications: inject(NotificationService),
    _documents: lazyInject(DOCUMENTS),
    /** Pre-edit snapshot for a rect-input editing session (X/Y/W/H), committed on blur. */
    _rectEdit: { snapshot: null as DocumentSnapshot | null },
    _statusTimer: { id: null as ReturnType<typeof setTimeout> | null },
  })),
  withComputed((store) => {
    const activeField = computed<StoreField | null>(() => {
      const uid = store.activeFieldUid();
      return uid ? (store._doc.fields().find((f) => f.uid === uid) ?? null) : null;
    });
    const pendingOps = computed(() => computeFieldOps(store._doc.fields(), store._doc.fieldsBaseline()));
    const historyBlocked = computed(
      () => store.historyBusy() || store._doc.isDocumentUpdating() || store._doc.documentLoadInFlight(),
    );
    return {
      activeField,
      activeFieldEditable: computed(() => isEditableField(activeField())),
      pendingOps,
      pendingCount: computed(() => pendingOps().length),
      pendingDescription: computed(() => describePendingFieldChanges(pendingOps())),
      pendingRows: computed(() => buildPendingChangesDetails(pendingOps())),
      canUndo: computed(() => !historyBlocked() && store._doc.hasDocument() && store.undoStack().length > 0),
      canRedo: computed(() => !historyBlocked() && store._doc.hasDocument() && store.redoStack().length > 0),
      canPlace: computed(() => store._doc.hasDocument() && !!store.addName().trim()),
      /** Signatures section header: how many signature fields still wait to be signed. */
      hero: computed(() => {
        const sigs = store._doc.fields().filter((f) => f.type === 'Signature');
        const unsigned = sigs.filter(isEditableField).length;
        return { total: sigs.length, unsigned, signed: sigs.length - unsigned };
      }),
    };
  }),
  withLinkedState((store) => ({
    /** The "Field Details (raw PDF properties)" <details> in the Edit sheet; turning raw data on opens it. */
    fieldDetailsOpen: linkedSignal({
      source: () => store._settings.effective().showRawPdfData,
      computation: (showRaw: boolean, previous?: { value: boolean }) => showRaw || (previous?.value ?? false),
    }),
    /** The pending-changes bar's "View changes" popover; it closes with the bar. */
    pendingDetailsOpen: linkedSignal({
      source: () => store.pendingCount() > 0,
      computation: (hasPending: boolean, previous?: { value: boolean }) => hasPending && (previous?.value ?? false),
    }),
  })),
  withMethods((store) => {
    const doc = store._doc;
    const viewer = store._viewer;
    const ui = store._ui;
    const notify = store._notifications;

    const isStaged = (field: StoreField) => isFieldStaged(field, doc.fieldsBaseline());

    function setStatus(message: string, type: StatusType = 'loading'): void {
      patchState(store, { status: { message, type } });
      if (store._statusTimer.id) clearTimeout(store._statusTimer.id);
      store._statusTimer.id = setTimeout(() => {
        if (store.status()?.message === message) patchState(store, { status: null });
      }, 3000);
    }

    // ---- History ----

    function commitSnapshot(snapshot: DocumentSnapshot): void {
      const undo = [...store.undoStack(), snapshot];
      if (undo.length > FIELD_HISTORY_LIMIT) undo.shift();
      patchState(store, { undoStack: undo, redoStack: [] });
    }

    function pushHistory(): void {
      commitSnapshot(store._documents().captureSnapshot());
    }

    function resetHistory(): void {
      store._rectEdit.snapshot = null;
      patchState(store, { undoStack: [], redoStack: [] });
    }

    /**
     * A version write landing at `fromIndex` replaced whatever bytes lived
     * there; redo entries aimed at that index or higher no longer match the
     * stored bytes and are dropped.
     */
    function dropStaleRedoEntries(fromIndex: number): void {
      const redo = store.redoStack();
      if (!redo.length) return;
      const sessionId = doc.documentSessionId();
      const kept = redo.filter((snap) => snap.documentSessionId !== sessionId || snap.documentRevisionCount < fromIndex);
      if (kept.length !== redo.length) patchState(store, { redoStack: kept });
    }

    /**
     * Revision hydration re-keyed the open file (and renumbered its stored
     * version); steps that pointed at the old key now point at the new one.
     */
    function remapHistoryVersion(sessionId: string, fromKey: string | null, revisionCount: number, versionKey: string | null): void {
      const remap = (snap: DocumentSnapshot): DocumentSnapshot =>
        snap.documentSessionId === sessionId && snap.activeVersionKey === fromKey
          ? { ...snap, documentRevisionCount: revisionCount, activeVersionKey: versionKey }
          : snap;
      if (store._rectEdit.snapshot) store._rectEdit.snapshot = remap(store._rectEdit.snapshot);
      patchState(store, { undoStack: store.undoStack().map(remap), redoStack: store.redoStack().map(remap) });
    }

    async function step(direction: 'undo' | 'redo'): Promise<void> {
      const source = direction === 'undo' ? store.undoStack() : store.redoStack();
      // Blocked mid-load/mid-update: the live state is momentarily inconsistent.
      if (store.historyBusy() || !source.length || doc.isDocumentUpdating() || doc.documentLoadInFlight()) return;
      // Peek first: a cross-document step must open its target before the
      // stacks are touched, so a failed/superseded open leaves history intact.
      const candidate = source[source.length - 1];
      patchState(store, { historyBusy: true });
      try {
        let target = null;
        if (!store._documents().isCurrentSnapshot(candidate)) {
          try {
            target = await store._documents().openHistoryTarget(candidate);
          } catch (err) {
            // Its bytes are gone for good -- drop the step so it can't block the rest.
            const drop = (stack: DocumentSnapshot[]) => stack.filter((snap) => snap !== candidate);
            patchState(store, direction === 'undo' ? { undoStack: drop(store.undoStack()) } : { redoStack: drop(store.redoStack()) });
            notify.show(`Could not ${direction}: ${errorMessage(err)}`, 'error');
            return;
          }
          if (!target) return; // superseded while opening
        }
        const current = store._documents().captureSnapshot();
        if (direction === 'undo') {
          patchState(store, { undoStack: store.undoStack().slice(0, -1), redoStack: [...store.redoStack(), current] });
        } else {
          patchState(store, { redoStack: store.redoStack().slice(0, -1), undoStack: [...store.undoStack(), current] });
        }
        await store._documents().applySnapshot(candidate, target);
      } finally {
        patchState(store, { historyBusy: false });
      }
    }

    // ---- Selection / Edit sheet ----

    function closeEditSheet(): void {
      ui.closeSheet('edit');
    }

    function select(uid: string): void {
      // Only one sheet slides over the column at a time.
      ui.closeSheet('certificate');
      ui.closeSheet('certificateTimeline');
      patchState(store, { activeFieldUid: uid });
      ui.openSheet('edit');
    }

    function deselect(): void {
      closeEditSheet();
      patchState(store, { activeFieldUid: null, fieldDetailsOpen: false });
    }

    // ---- Placement ----

    function clearPendingField(): void {
      patchState(store, { isPlacing: false });
    }

    function resetAddForm(): void {
      patchState(store, {
        addName: '',
        addRequired: false,
        addWidth: FIELD_TYPE_CONFIG.signature.defaultWidth,
        addHeight: FIELD_TYPE_CONFIG.signature.defaultHeight,
      });
    }

    /**
     * Pushes one already-named field into the working list as a staged
     * change. A lone field gets its own history step; a batch passes
     * `history: false` and pushes one step for the whole batch.
     */
    function stageNewField(
      field: { name: string; required?: boolean; page: number | null; rect: PdfRect },
      options: { history?: boolean } = {},
    ): void {
      if (options.history !== false) pushHistory();
      const staged: StoreField = {
        uid: nextFieldUid(),
        name: field.name,
        type: 'Signature',
        required: !!field.required,
        readOnly: false,
        tooltip: '',
        page: field.page,
        rect: { x: field.rect.x, y: field.rect.y, width: field.rect.width, height: field.rect.height },
      };
      doc.setFields([...doc.fields(), staged]);
    }

    function placeFieldAt(clickX: number, clickY: number): void {
      const viewport = viewer.viewport();
      if (!viewport) return;
      const widthPdf = Number(store.addWidth()) || 200;
      const heightPdf = Number(store.addHeight()) || 60;
      const scaleX = viewport.scaleX ?? viewport.scale;
      const scaleY = viewport.scaleY ?? scaleX;
      const canvas = viewer.canvasSize();

      const screenW = widthPdf * scaleX;
      const screenH = heightPdf * scaleY;
      // Keep the field fully inside the visible page.
      const screenLeft = Math.max(0, Math.min(clickX - screenW / 2, canvas.width - screenW));
      const screenTop = Math.max(0, Math.min(clickY - screenH / 2, canvas.height - screenH));
      const rect = viewer.screenRectToPdf(screenLeft, screenTop, screenW, screenH);
      const page = viewer.pageNum() - 1;
      patchState(store, { isPlacing: false });

      // Dropping the field stages it immediately -- "Apply changes" is the real commit.
      const name = store.addName().trim();
      if (!name) {
        notify.show('Enter a field name.', 'error');
        return;
      }
      if (doc.fields().some((f) => f.name === name)) {
        notify.show(`A field named "${name}" already exists.`, 'error');
        return;
      }
      stageNewField({ name, required: store.addRequired(), page, rect });
      resetAddForm();
      notify.show(`"${name}" staged — click Apply changes to save it.`, 'info');
    }

    // ---- Editing the selected field ----

    function commitRect(uid: string, rect: PdfRect): void {
      pushHistory();
      doc.updateField(uid, { rect });
    }

    /** Live rect edit from the X/Y/W/H inputs; history is committed on blur. */
    function liveRect(rect: PdfRect): void {
      const field = store.activeField();
      if (!field || !viewer.viewport()) return;
      if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) return;
      doc.updateField(field.uid, { rect });
    }

    function beginRectEdit(): void {
      if (store._rectEdit.snapshot === null) store._rectEdit.snapshot = store._documents().captureSnapshot();
    }

    function endRectEdit(): void {
      const snapshot = store._rectEdit.snapshot;
      if (snapshot === null) return;
      if (JSON.stringify(snapshot.documentFields) !== JSON.stringify(doc.fields())) commitSnapshot(snapshot);
      store._rectEdit.snapshot = null;
    }

    function cancelRectEdit(): void {
      store._rectEdit.snapshot = null;
    }

    /**
     * Renaming stages immediately, committed on blur so a half-typed name
     * isn't flagged as a duplicate. Returns the name now in effect.
     */
    function renameActive(rawName: string): string {
      const field = store.activeField();
      if (!field) return rawName;
      const newName = rawName.trim();
      if (!newName || newName === field.name) return field.name;
      if (doc.fields().some((f) => f.uid !== field.uid && f.name === newName)) {
        notify.show(`A field named "${newName}" already exists.`, 'error');
        return field.name;
      }
      pushHistory();
      doc.updateField(field.uid, { name: newName });
      return newName;
    }

    function setActiveRequired(required: boolean): void {
      const field = store.activeField();
      if (!field) return;
      pushHistory();
      doc.updateField(field.uid, { required });
    }

    function removeFieldByName(fieldName: string): void {
      if (!doc.activeFile()) return;
      const wasActive = store.activeField()?.name === fieldName;
      pushHistory();
      doc.setFields(doc.fields().filter((f) => f.name !== fieldName));
      if (wasActive) deselect();
      notify.show(`"${fieldName}" removed — click Apply changes to save it.`, 'info');
    }

    // ---- Apply / discard ----

    /**
     * Sends every staged op as one request. Resolves whether it succeeded (or
     * there was nothing to send). Also used before Download/Share/Copy so no
     * export misses in-progress edits.
     */
    async function applyPending(): Promise<boolean> {
      const ops = store.pendingOps();
      if (!ops.length) return true;
      const documents = store._documents();
      // Let an in-flight hydration finish writing before this edit's own row.
      await documents.ensureRevisionHydration();
      // Committed to history only on success, so a failed apply leaves no no-op step.
      const preApplySnapshot = documents.captureSnapshot();
      const formData = new FormData();
      formData.append('pdfDocument', doc.activeFile() as Blob);
      formData.append('ops', serializeOps(ops));
      const label = ops.length === 1 ? '1 change' : `${ops.length} changes`;
      // withFields returns the updated field list with the PDF, saving a round trip.
      const success = await documents.handleApiUpdate('/api/apply-changes?withFields=true', formData, `Applied ${label}.`);
      if (success) commitSnapshot(preApplySnapshot);
      return success;
    }

    function discardPending(): void {
      if (!store.pendingOps().length) return;
      pushHistory();
      doc.setFields(
        doc.fieldsBaseline().map((f) => ({ ...f, rect: f.rect ? { ...f.rect } : null })),
      );
      deselect();
      clearPendingField();
      patchState(store, { pendingHideReason: 'discard' });
      notify.show('Discarded unsaved field changes.', 'info');
    }

    return {
      setStatus,
      commitSnapshot,
      pushHistory,
      resetHistory,
      dropStaleRedoEntries,
      remapHistoryVersion,
      undo: () => step('undo'),
      redo: () => step('redo'),
      select,
      deselect,
      clearPendingField,
      resetAddForm,
      stageNewField,
      placeFieldAt,
      commitRect,
      liveRect,
      beginRectEdit,
      endRectEdit,
      cancelRectEdit,
      renameActive,
      setActiveRequired,
      removeFieldByName,
      applyPending,
      discardPending,
      isStaged,
      setAddForm(changes: Partial<Pick<SignaturesState, 'addName' | 'addWidth' | 'addHeight' | 'addRequired'>>): void {
        patchState(store, changes);
      },
      startPlacing(): void {
        if (!doc.pdfDoc()) return;
        patchState(store, { isPlacing: true });
      },
      setFieldDetailsOpen(open: boolean): void {
        patchState(store, { fieldDetailsOpen: open });
      },
      togglePendingDetails(): void {
        patchState(store, { pendingDetailsOpen: !store.pendingDetailsOpen() });
      },
      setPendingHideReason(reason: 'apply' | 'discard' | null): void {
        patchState(store, { pendingHideReason: reason });
      },
      setEditSheetSuppressed(suppressed: boolean): void {
        patchState(store, { editSheetSuppressed: suppressed });
      },
      openRemoveFieldModal(fieldName: string): void {
        ui.removeFieldName.set(fieldName);
      },
      /** The selected field's name, for the Edit sheet's Remove button. */
      requestRemoveActive(): void {
        const field = store.activeField();
        if (!doc.activeFile() || !field || !field.name) return;
        ui.removeFieldName.set(field.name);
      },
      /** Resets selection, placement and forms for a new/reloaded document. */
      resetForNewDocument(): void {
        clearPendingField();
        patchState(store, { activeFieldUid: null, fieldDetailsOpen: false, status: null });
        closeEditSheet();
        resetAddForm();
      },
      /** Certificates -> Signatures: open the section and select that field. */
      async showFieldOnDocument(fieldName: string): Promise<void> {
        const field = doc.fields().find((f) => f.name === fieldName);
        if (!field) {
          notify.show(`This signature's field (${fieldName}) is not on the document.`, 'info');
          return;
        }
        ui.closeSheet('certificate');
        await ui.goToSection('signatures');
        if (typeof field.page === 'number' && field.page + 1 !== viewer.pageNum()) {
          await viewer.goToPage(field.page + 1).catch(() => {});
        }
        select(field.uid);
      },
      selectByName(fieldName: string): void {
        const field = doc.fields().find((f) => f.name === fieldName);
        if (field) select(field.uid);
      },
    };
  }),
  withHooks({
    onInit(store) {
      // Safety net: a reload or snapshot restore can drop the selection
      // without going through deselect() -- the sheet follows the selection.
      effect(() => {
        if (!store.activeField() && store.activeFieldUid()) store.deselect();
        if (!store._doc.hasDocument() && store._ui.sheets.edit()) store._ui.closeSheet('edit');
      });
    },
  }),
);

export type SignaturesStore = InstanceType<typeof SignaturesStore>;
