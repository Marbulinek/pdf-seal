import { DOCUMENT } from '@angular/common';
import { computed, effect, inject } from '@angular/core';
import { patchState, signalStore, withComputed, withHooks, withMethods, withProps, withState } from '@ngrx/signals';
import {
  TEMPLATE_STORE_VERSION,
  buildTemplateExport,
  copyTemplateItem,
  mergeTemplateStores,
  moveTemplateItem,
  normalizeTemplateStore,
  parseTemplateExport,
  planAutoPlacement,
  templateItemFromField,
  uniqueFieldName,
  upsertTemplateItem,
  type SignatureTemplate,
  type TemplateItem,
  type TemplateStore,
} from './signature-templates';
import { errorMessage } from '../../core/document.service';
import { DocumentStore, type StoreField } from '../../core/document.store';
import { isEditableField } from '../../core/field-rules';
import { NotificationService } from '../../core/notification.service';
import { UiService } from '../../core/ui.service';
import { downloadBlob } from '../../core/util/dom';
import { formatTemplateNumber, plural, pluralize } from '../../core/util/format';
import { makeTemplateId } from '../../core/util/ids';
import { ViewerService } from '../../core/viewer.service';
import { SignaturesStore } from './signatures.store';

export const TEMPLATES_STORAGE_KEY = 'pdfseal-signature-templates';
export const TEMPLATE_DRAG_MIME = 'application/x-pdfseal-template-item';
export const DOCUMENT_FIELD_DRAG_MIME = 'application/x-pdfseal-document-field';

export interface CleanupOption {
  value: 'none' | 'signature';
  title: string;
  desc: string;
  disabled?: boolean;
}

interface TemplatesState {
  templateStore: TemplateStore;
  selectedTemplateId: string | null;
  autoPlace: boolean;
  /** The Templates panel's "Saved fields" <details>. */
  itemListOpen: boolean;
  /** The tour sandboxes templates: saves stay in memory, backups read storage. */
  sandboxActive: boolean;
  sandboxStash: { templateStore: TemplateStore; selectedTemplateId: string | null } | null;
  /** A field being dragged off the page into the panel (capture). */
  draggingDocumentFieldUid: string | null;
  /** A saved item being dragged from the panel onto the page (manual placement). */
  draggingTemplateItem: { item: TemplateItem; templateId: string } | null;
  dropzoneActive: boolean;
  // ---- Modals ----
  nameModal: { open: boolean; editingId: string | null; status: string };
  /** A field dropped before any template existed, waiting for the new template's name. */
  pendingCaptureFieldUid: string | null;
  moveModal: { itemId: string; sourceTemplateId: string; status: string } | null;
  deleteTemplateId: string | null;
  removeItem: { templateId: string; itemId: string } | null;
  cleanup: { templateId: string; docSig: number; value: 'none' | 'signature' } | null;
  importModal: { store: TemplateStore; fileName: string } | null;
}

function loadTemplateStore(): TemplateStore {
  try {
    const raw = localStorage.getItem(TEMPLATES_STORAGE_KEY);
    if (!raw) return { version: TEMPLATE_STORE_VERSION, templates: [] };
    return normalizeTemplateStore(JSON.parse(raw));
  } catch {
    return { version: TEMPLATE_STORE_VERSION, templates: [] };
  }
}

function countTemplateFields(store: TemplateStore): number {
  return store.templates.reduce((total, template) => total + template.items.length, 0);
}

/** The full geometry, kept in a tooltip -- sizes and positions come from the page, not a form. */
export function templateItemSummary(item: TemplateItem): string {
  const parts = [
    item.type === 'text' ? 'TextBox — not placeable' : 'Signature',
    `${formatTemplateNumber(item.width)} × ${formatTemplateNumber(item.height)} pt`,
    `page ${item.page + 1}`,
    `X ${formatTemplateNumber(item.x)}, Y ${formatTemplateNumber(item.y)}`,
  ];
  if (item.required) parts.push('required');
  if (item.type === 'text' && item.multiline) parts.push('multiline');
  return parts.join(' · ');
}

const initialTemplateStore = loadTemplateStore();

const initialState: TemplatesState = {
  templateStore: initialTemplateStore,
  selectedTemplateId: initialTemplateStore.templates[0]?.id ?? null,
  autoPlace: false,
  itemListOpen: false,
  sandboxActive: false,
  sandboxStash: null,
  draggingDocumentFieldUid: null,
  draggingTemplateItem: null,
  dropzoneActive: false,
  nameModal: { open: false, editingId: null, status: '' },
  pendingCaptureFieldUid: null,
  moveModal: null,
  deleteTemplateId: null,
  removeItem: null,
  cleanup: null,
  importModal: null,
};

/**
 * Signature templates: named, reusable lists of field definitions, kept in
 * this browser. A template is filled by dragging fields already placed on the
 * document into the panel, and spent by dragging an item back onto the page
 * or placing the whole list at its saved positions in one batch.
 */
export const TemplatesStore = signalStore(
  { providedIn: 'root' },
  withState(initialState),
  withProps(() => ({
    _doc: inject(DocumentStore),
    _viewer: inject(ViewerService),
    _ui: inject(UiService),
    _notifications: inject(NotificationService),
    _signatures: inject(SignaturesStore),
  })),
  withComputed((store) => {
    const templates = computed(() => store.templateStore().templates);
    const selectedTemplate = computed<SignatureTemplate | null>(() => {
      const list = templates();
      return list.find((t) => t.id === store.selectedTemplateId()) ?? list[0] ?? null;
    });
    /** The store the Settings backup buttons read: persisted storage while sandboxed. */
    const backupStore = computed(() => {
      if (!store.sandboxActive()) return store.templateStore();
      return store.sandboxStash()?.templateStore ?? loadTemplateStore();
    });
    return {
      templates,
      hasTemplates: computed(() => templates().length > 0),
      selectedTemplate,
      selectedCount: computed(() => selectedTemplate()?.items.length ?? 0),
      backupStore,
      backupTemplateCount: computed(() => backupStore().templates.length),
      backupFieldCount: computed(() => countTemplateFields(backupStore())),
      /** Manual placement is a drag off the panel -- only with a document and in manual mode. */
      rowsDraggable: computed(() => store._doc.hasDocument() && !store.autoPlace()),
    };
  }),
  withMethods((store) => {
    const notify = store._notifications;
    const doc = store._doc;
    const viewer = store._viewer;

    function saveTemplateStore(next: TemplateStore): void {
      const normalized = normalizeTemplateStore(next);
      patchState(store, { templateStore: normalized });
      if (!store.sandboxActive()) {
        try {
          localStorage.setItem(TEMPLATES_STORAGE_KEY, JSON.stringify(normalized));
        } catch {
          // Quota/privacy mode -- the in-memory store still works this session.
          notify.show('Could not save templates to this browser. Changes will be lost on reload.', 'error');
        }
      }
    }

    function findTemplate(id: string | null): SignatureTemplate | null {
      return store.templates().find((t) => t.id === id) ?? null;
    }

    /**
     * Copies one placed field into `templateId`, replacing the saved item of
     * the same name -- re-dragging a moved field is how you update it.
     */
    function saveFieldToTemplate(field: StoreField | null, templateId: string): void {
      const template = findTemplate(templateId);
      if (!template || !field) return;
      const item = templateItemFromField(
        {
          name: field.name,
          type: field.type,
          required: field.required,
          page: field.page ?? 0,
          // A rect-less field falls back to the template defaults, like the original.
          rect: field.rect ?? { x: NaN, y: NaN, width: NaN, height: NaN },
        },
        makeTemplateId('itm'),
      );
      if (!item) {
        notify.show('Only signature fields can be saved to a template.', 'error');
        return;
      }
      if (!item.name) {
        notify.show('Give the field a name before saving it to a template.', 'error');
        return;
      }
      const { items, replaced } = upsertTemplateItem(template.items, item);
      saveTemplateStore({
        ...store.templateStore(),
        templates: store.templates().map((t) => (t.id === templateId ? { ...t, items, updatedAt: Date.now() } : t)),
      });
      notify.show(
        replaced ? `Updated "${item.name}" in "${template.name}".` : `Saved "${item.name}" to "${template.name}".`,
        'success',
      );
      // The Edit sheet was only suppressed for the drag; land back on the default view.
      if (store._signatures.activeFieldUid() === field.uid) store._signatures.deselect();
    }

    function runPlaceTemplateBatch(template: SignatureTemplate, removeKind: 'none' | 'signature' | null): void {
      const pdfDoc = doc.pdfDoc();
      if (!pdfDoc) return;
      const plan = planAutoPlacement(template.items, new Set(doc.fields().map((f) => f.name)), pdfDoc.numPages);
      const removing = !!removeKind && removeKind !== 'none';

      if (plan.placements.length || removing) {
        // One history entry for the whole batch (removals included).
        store._signatures.pushHistory();
        let removedCount = 0;
        if (removing) {
          const before = doc.fields().length;
          doc.setFields(doc.fields().filter((f) => !isEditableField(f)));
          removedCount = before - doc.fields().length;
          if (store._signatures.activeFieldUid() && !store._signatures.activeField()) store._signatures.deselect();
        }
        plan.placements.forEach((placement) =>
          store._signatures.stageNewField(
            {
              name: placement.name,
              required: placement.required,
              page: placement.page,
              rect: { x: placement.rect.x, y: placement.rect.y, width: placement.rect.width, height: placement.rect.height },
            },
            { history: false },
          ),
        );

        const count = plan.placements.length;
        const removedNote = removedCount ? `Removed ${removedCount} existing field${plural(removedCount)}, then ` : '';
        if (count) {
          notify.show(
            `${removedNote}staged ${count} field${plural(count)} from "${template.name}" — click Apply changes to save ${count === 1 ? 'it' : 'them'}.`,
            'info',
          );
        } else if (removedCount) {
          notify.show(`Removed ${removedCount} existing field${plural(removedCount)} — click Apply changes to save it.`, 'info');
        }
      }

      if (plan.skipped.length) {
        const names = plan.skipped.map((s) => `"${s.name}" (page ${s.page + 1})`).join(', ');
        const textOnly = plan.skipped.every((s) => s.reason === 'unsupported-type');
        const n = plan.skipped.length;
        notify.show(
          textOnly
            ? `Skipped ${n} TextBox item${plural(n)} — text fields are no longer created: ${names}.`
            : `Skipped ${n} field${plural(n)} — not placeable (missing page or TextBox item; this document has ${pdfDoc.numPages} page${plural(pdfDoc.numPages)}): ${names}.`,
          'error',
          12000,
        );
      }
    }

    return {
      saveTemplateStore,
      saveFieldToTemplate,
      selectTemplate(id: string): void {
        patchState(store, { selectedTemplateId: id });
      },
      setAutoPlace(auto: boolean): void {
        if (!store.hasTemplates()) return;
        patchState(store, { autoPlace: auto });
      },
      setItemListOpen(open: boolean): void {
        patchState(store, { itemListOpen: open });
      },

      // ---- Capture: drag a field off the page into the active template ----
      beginDocumentFieldDrag(field: StoreField): void {
        patchState(store, { draggingDocumentFieldUid: field.uid });
        store._ui.signatureTab.set('templates');
        store._signatures.setEditSheetSuppressed(true);
      },
      endDocumentFieldDrag(): void {
        patchState(store, { draggingDocumentFieldUid: null, dropzoneActive: false });
        store._signatures.setEditSheetSuppressed(false);
      },
      setDropzoneActive(active: boolean): void {
        patchState(store, { dropzoneActive: active });
      },
      dropCapturedField(): void {
        const uid = store.draggingDocumentFieldUid();
        const field = doc.fields().find((f) => f.uid === uid) ?? null;
        patchState(store, { draggingDocumentFieldUid: null, dropzoneActive: false });
        store._signatures.setEditSheetSuppressed(false);
        if (!field) return;
        const selected = store.selectedTemplate();
        if (!selected) {
          // Nothing to drop into yet -- ask for a name; the field lands in what that creates.
          patchState(store, { pendingCaptureFieldUid: field.uid });
          patchState(store, { nameModal: { open: true, editingId: null, status: '' } });
          return;
        }
        saveFieldToTemplate(field, selected.id);
      },

      // ---- Manual placement: drag an item from the panel onto the page ----
      beginTemplateItemDrag(item: TemplateItem, templateId: string): void {
        patchState(store, { draggingTemplateItem: { item, templateId } });
      },
      endTemplateItemDrag(): void {
        patchState(store, { draggingTemplateItem: null });
      },
      /**
       * Drops one item at a point on the current page. Its saved page/x/y are
       * ignored -- a dragged field belongs where the user dropped it.
       */
      placeTemplateItemAt(item: TemplateItem, clickX: number, clickY: number): void {
        patchState(store, { draggingTemplateItem: null });
        const viewport = viewer.viewport();
        if (!doc.pdfDoc() || !viewport) return;
        if (item.type === 'text') {
          notify.show(`Skipped "${item.name}" — text fields are no longer created.`, 'error');
          return;
        }
        const scaleX = viewport.scaleX ?? viewport.scale;
        const scaleY = viewport.scaleY ?? scaleX;
        const canvas = viewer.canvasSize();
        const screenW = item.width * scaleX;
        const screenH = item.height * scaleY;
        const screenLeft = Math.max(0, Math.min(clickX - screenW / 2, canvas.width - screenW));
        const screenTop = Math.max(0, Math.min(clickY - screenH / 2, canvas.height - screenH));

        const name = uniqueFieldName(item.name, new Set(doc.fields().map((f) => f.name)));
        store._signatures.stageNewField({
          name,
          required: item.required,
          page: viewer.pageNum() - 1,
          rect: viewer.screenRectToPdf(screenLeft, screenTop, screenW, screenH),
        });
        const renamed = name !== item.name ? ` as "${name}"` : '';
        notify.show(`"${item.name}" staged${renamed} — click Apply changes to save it.`, 'info');
      },

      // ---- Automatic placing: stage the whole list in one batch ----
      placeTemplateBatch(): void {
        const template = store.selectedTemplate();
        if (!template || !doc.pdfDoc() || !template.items.length) return;
        // Only unsigned signature fields are ever replaceable.
        const signatureCount = doc.fields().filter(isEditableField).length;
        if (signatureCount) {
          patchState(store, { cleanup: { templateId: template.id, docSig: signatureCount, value: 'none' } });
          return;
        }
        runPlaceTemplateBatch(template, null);
      },
      cleanupOptions(): CleanupOption[] {
        const cleanup = store.cleanup();
        const template = findTemplate(cleanup?.templateId ?? null);
        if (!cleanup || !template) return [];
        const tplSig = template.items.filter((i) => i.type !== 'text').length;
        const tplText = template.items.length - tplSig;
        const textNote = tplText ? ` ${pluralize(tplText, 'TextBox item')} will be skipped (text fields are no longer created).` : '';
        return [
          {
            value: 'none',
            title: 'Keep existing fields',
            desc: `Adds the template's ${pluralize(tplSig, 'signature field')} alongside what's already on the document.${textNote}`,
          },
          {
            value: 'signature',
            title: 'Replace unsigned signature fields',
            desc: `Removes the document's ${pluralize(cleanup.docSig, 'unsigned signature field')}, then places the template's ${pluralize(tplSig, 'signature field')}. Signed signatures and other fields are left alone.${textNote}`,
            disabled: !cleanup.docSig && !tplSig,
          },
        ];
      },
      setCleanupValue(value: 'none' | 'signature'): void {
        const cleanup = store.cleanup();
        if (cleanup) patchState(store, { cleanup: { ...cleanup, value } });
      },
      closeCleanup(): void {
        patchState(store, { cleanup: null });
      },
      confirmCleanup(): void {
        const cleanup = store.cleanup();
        patchState(store, { cleanup: null });
        const template = findTemplate(cleanup?.templateId ?? null);
        if (!cleanup || !template) return;
        runPlaceTemplateBatch(template, cleanup.value);
      },

      // ---- Name modal (create + rename) ----
      openNameModal(templateId: string | null): void {
        const existing = findTemplate(templateId);
        patchState(store, { nameModal: { open: true, editingId: existing?.id ?? null, status: '' } });
      },
      closeNameModal(): void {
        // A field waiting on a template it never got has nowhere to go.
        patchState(store, { nameModal: { open: false, editingId: null, status: '' }, pendingCaptureFieldUid: null });
      },
      submitTemplateName(rawName: string): void {
        const name = rawName.trim();
        const modal = store.nameModal();
        if (!name) {
          patchState(store, { nameModal: { ...modal, status: 'Give the template a name.' } });
          return;
        }
        const clash = store.templates().some((t) => t.id !== modal.editingId && t.name.toLowerCase() === name.toLowerCase());
        if (clash) {
          patchState(store, { nameModal: { ...modal, status: `A template named "${name}" already exists.` } });
          return;
        }
        const now = Date.now();
        const isRename = !!modal.editingId;
        const captured = doc.fields().find((f) => f.uid === store.pendingCaptureFieldUid()) ?? null;
        let savedId = modal.editingId;
        let templates: SignatureTemplate[];
        if (isRename) {
          templates = store.templates().map((t) => (t.id === savedId ? { ...t, name, updatedAt: now } : t));
        } else {
          savedId = makeTemplateId('tpl');
          templates = [...store.templates(), { id: savedId, name, createdAt: now, updatedAt: now, items: [] }];
          patchState(store, { selectedTemplateId: savedId });
        }
        saveTemplateStore({ ...store.templateStore(), templates });
        patchState(store, { nameModal: { open: false, editingId: null, status: '' }, pendingCaptureFieldUid: null });

        if (!isRename && captured && savedId) saveFieldToTemplate(captured, savedId);
        else notify.show(isRename ? `Renamed template to "${name}".` : `Created template "${name}".`, 'success');
      },
      capturedFieldName(): string | null {
        return doc.fields().find((f) => f.uid === store.pendingCaptureFieldUid())?.name ?? null;
      },

      // ---- Move/copy-item modal ----
      openMoveModal(itemId: string, sourceTemplateId: string): void {
        const others = store.templates().filter((t) => t.id !== sourceTemplateId);
        if (!findTemplate(sourceTemplateId) || !others.length) return;
        patchState(store, { moveModal: { itemId, sourceTemplateId, status: '' } });
      },
      closeMoveModal(): void {
        patchState(store, { moveModal: null });
      },
      confirmMove(mode: 'move' | 'copy', targetId: string): void {
        const move = store.moveModal();
        if (!move || !targetId) return;
        const isCopy = mode === 'copy';
        const target = findTemplate(targetId);
        const item = findTemplate(move.sourceTemplateId)?.items.find((i) => i.id === move.itemId);
        saveTemplateStore(
          isCopy
            ? copyTemplateItem(store.templateStore(), move.sourceTemplateId, targetId, move.itemId)
            : moveTemplateItem(store.templateStore(), move.sourceTemplateId, targetId, move.itemId),
        );
        patchState(store, { moveModal: null });
        notify.show(`${isCopy ? 'Copied' : 'Moved'} "${item?.name ?? 'Field'}" to "${target?.name ?? 'the other template'}".`, 'success');
      },

      // ---- Delete-template modal ----
      openDeleteModal(templateId: string): void {
        if (findTemplate(templateId)) patchState(store, { deleteTemplateId: templateId });
      },
      closeDeleteModal(): void {
        patchState(store, { deleteTemplateId: null });
      },
      confirmDelete(): void {
        const id = store.deleteTemplateId();
        if (!id) return;
        const template = findTemplate(id);
        const templates = store.templates().filter((t) => t.id !== id);
        if (store.selectedTemplateId() === id) patchState(store, { selectedTemplateId: templates[0]?.id ?? null });
        patchState(store, { deleteTemplateId: null });
        saveTemplateStore({ ...store.templateStore(), templates });
        notify.show(`Deleted template "${template?.name ?? ''}".`, 'info');
      },

      // ---- Remove-item modal ----
      openRemoveItemModal(templateId: string, itemId: string): void {
        const template = findTemplate(templateId);
        if (template?.items.some((i) => i.id === itemId)) patchState(store, { removeItem: { templateId, itemId } });
      },
      closeRemoveItemModal(): void {
        patchState(store, { removeItem: null });
      },
      confirmRemoveItem(): void {
        const pending = store.removeItem();
        patchState(store, { removeItem: null });
        if (!pending) return;
        const template = findTemplate(pending.templateId);
        const item = template?.items.find((i) => i.id === pending.itemId);
        if (!template || !item) return;
        saveTemplateStore({
          ...store.templateStore(),
          templates: store.templates().map((t) =>
            t.id === pending.templateId
              ? { ...t, items: t.items.filter((i) => i.id !== pending.itemId), updatedAt: Date.now() }
              : t,
          ),
        });
        notify.show(`Removed "${item.name}" from "${template.name}".`, 'info');
      },

      // ---- Backup: download / load the store as JSON ----
      exportToFile(): void {
        const backup = store.backupStore();
        if (!backup.templates.length) return;
        const payload = JSON.stringify(buildTemplateExport(backup), null, 2);
        // Date-stamped so successive backups sit side by side in Downloads.
        downloadBlob(
          new Blob([payload], { type: 'application/json' }),
          `pdf-seal-templates-${new Date().toISOString().slice(0, 10)}.json`,
        );
        const count = store.templates().length;
        notify.show(`Downloaded ${count} template${plural(count)}.`, 'success');
      },
      async importFile(file: File | null | undefined): Promise<void> {
        if (!file) return;
        try {
          const parsed = parseTemplateExport(await file.text());
          patchState(store, { importModal: { store: parsed, fileName: file.name } });
        } catch (err) {
          notify.show(`Could not load templates: ${errorMessage(err)}`, 'error', 10000);
        }
      },
      closeImportModal(): void {
        patchState(store, { importModal: null });
      },
      applyImport(mode: 'merge' | 'replace'): void {
        const pending = store.importModal();
        if (!pending) return;
        const incoming = pending.store;
        if (mode === 'replace') {
          const count = incoming.templates.length;
          patchState(store, { selectedTemplateId: incoming.templates[0]?.id ?? null, importModal: null });
          saveTemplateStore(incoming);
          notify.show(`Replaced your templates with the ${count} from the file.`, 'success');
          return;
        }
        const result = mergeTemplateStores(store.templateStore(), incoming);
        // Land on the first thing that just arrived.
        const firstAdded = result.store.templates.find((t) => t.name === result.added[0]);
        if (firstAdded) patchState(store, { selectedTemplateId: firstAdded.id });
        patchState(store, { importModal: null });
        saveTemplateStore(result.store);
        const count = result.added.length;
        notify.show(`Added ${count} template${plural(count)} from the file.`, 'success');
        if (result.renamed.length) {
          const names = result.renamed.map((r) => `"${r.from}" → "${r.to}"`).join(', ');
          notify.show(`Renamed to avoid clashing with templates you already had: ${names}.`, 'info', 10000);
        }
      },
      countFields(templateStore: TemplateStore): number {
        return countTemplateFields(templateStore);
      },

      // ---- Tour sandbox ----
      activateSandbox(): void {
        if (store.sandboxActive()) return;
        patchState(store, {
          sandboxStash: { templateStore: store.templateStore(), selectedTemplateId: store.selectedTemplateId() },
          sandboxActive: true,
          templateStore: { version: TEMPLATE_STORE_VERSION, templates: [] },
          selectedTemplateId: null,
        });
      },
      restoreSandbox(): void {
        const stash = store.sandboxStash();
        if (!store.sandboxActive() || !stash) return;
        patchState(store, {
          templateStore: stash.templateStore,
          selectedTemplateId: stash.selectedTemplateId,
          sandboxActive: false,
          sandboxStash: null,
        });
      },
      /** Adds a "Demo template" to the sandbox (once) and selects it. */
      ensureDemoTemplate(existingId: string | null): string {
        if (existingId && store.templates().some((t) => t.id === existingId)) return existingId;
        const demo: SignatureTemplate = {
          id: makeTemplateId('tpl'),
          name: 'Demo template',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          items: [],
        };
        patchState(store, {
          templateStore: { ...store.templateStore(), templates: [...store.templates(), demo] },
          selectedTemplateId: demo.id,
        });
        return demo.id;
      },
    };
  }),
  withHooks({
    onInit(store) {
      // Lights the panel up as a drop target for the whole capture drag.
      const body = inject(DOCUMENT).body;
      effect(() => body.classList.toggle('is-capturing-field', !!store.draggingDocumentFieldUid()));
    },
  }),
);

export type TemplatesStore = InstanceType<typeof TemplatesStore>;
