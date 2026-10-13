import { DOCUMENT } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import type { SignatureTemplate, TemplateItem } from '../../../../lib/SignatureTemplates';
import { DocumentStore } from '../../core/document.store';
import { SettingsService } from '../../core/settings.service';
import { UiService, type SignatureTab } from '../../core/ui.service';
import { ViewerService } from '../../core/viewer.service';
import { OvHero, type HeroModel } from '../../shared/ov-ui';
import { SignaturesStore } from './signatures.store';
import { TEMPLATE_DRAG_MIME, TemplatesStore, templateItemSummary } from './templates.store';

const PLACEMENT_HINT_PLACING = 'Click anywhere on the PDF to drop the field.';

/**
 * Signatures: undo/redo strip, then one panel with two tabs -- add a field by
 * placing it on the page, or reuse fields saved in a local template. Editing
 * a selected field happens in the Edit sheet.
 */
@Component({
  selector: 'section[appSignaturesSection]',
  imports: [OvHero],
  template: `
    <div class="history-strip" id="historyStrip">
      <span class="history-strip-label">History</span>
      <div class="history-actions">
        <button type="button" id="btnHistoryUndo" class="btn btn-ghost" [disabled]="!signatures.canUndo()" title="Undo (Ctrl+Z)" (click)="signatures.undo()">
          <span class="icon icon-undo" aria-hidden="true"></span> Undo
        </button>
        <button type="button" id="btnHistoryRedo" class="btn btn-ghost" [disabled]="!signatures.canRedo()" title="Redo (Ctrl+Shift+Z)" (click)="signatures.redo()">
          <span class="icon icon-redo" aria-hidden="true"></span> Redo
        </button>
      </div>
    </div>

    <div class="panel signature-panel">
      <div id="sigSectionHero">
        @if (hero(); as h) {
          <app-ov-hero [hero]="h" />
        }
      </div>
      <!-- With templates off, "Add field" stays as the panel's heading; a tablist of one would be a lie to a screen reader. -->
      <div class="sig-tabs" id="sigTabs" [attr.role]="templatesEnabled() ? 'tablist' : null" aria-label="Signature tools">
        <button
          type="button"
          class="sig-tab"
          id="sigTabAdd"
          data-sig-tab="add"
          [attr.role]="templatesEnabled() ? 'tab' : 'heading'"
          [attr.aria-level]="templatesEnabled() ? null : 3"
          [attr.aria-selected]="templatesEnabled() ? tab() === 'add' : null"
          aria-controls="sigTabPanelAdd"
          [class.is-active]="tab() === 'add'"
          (click)="setTab('add')"
        >
          <span class="icon icon-plus-bold" aria-hidden="true"></span> Add field
        </button>
        <button
          type="button"
          class="sig-tab"
          id="sigTabTemplates"
          data-sig-tab="templates"
          role="tab"
          [attr.aria-selected]="tab() === 'templates'"
          aria-controls="sigTabPanelTemplates"
          [class.is-active]="tab() === 'templates'"
          (click)="setTab('templates')"
        >
          <span class="icon icon-layers" aria-hidden="true"></span> Templates
        </button>
        <div class="sig-tabs-actions" id="sigTabsActions" [hidden]="tab() !== 'templates'">
          <button
            type="button"
            id="btnOpenTemplateSettings"
            class="icon-btn panel-h3-action"
            aria-label="Signature template settings"
            title="Manage &amp; backup templates"
            (click)="ui.openSettings('templates')"
          >
            <span class="icon icon-settings-gear" aria-hidden="true"></span>
          </button>
          <button type="button" id="btnNewTemplate" class="icon-btn" aria-label="New template" title="New template" (click)="templates.openNameModal(null)">
            <span class="icon icon-plus-bold" aria-hidden="true"></span>
          </button>
        </div>
      </div>

      <div class="sig-tab-panel" id="sigTabPanelAdd" data-sig-tab-panel="add" role="tabpanel" aria-labelledby="sigTabAdd" [hidden]="tab() !== 'add'">
        <!-- The overlay lives on this tab panel, not the whole card: templates stay editable with no document open. -->
        <div class="panel-overlay" id="addSigPanelOverlay" [class.is-hidden]="hasDoc()">
          <div class="panel-overlay-text">Upload a document first to add a field</div>
        </div>
        <form id="addSigForm" (submit)="$event.preventDefault()">
          <div class="form-group">
            <label for="sigName">Field Name</label>
            <input
              #nameInput
              type="text"
              id="sigName"
              placeholder="e.g. Signature1"
              required
              [disabled]="!hasDoc()"
              [value]="signatures.addName()"
              (input)="signatures.setAddForm({ addName: nameInput.value })"
            />
          </div>

          <div class="form-row">
            <div>
              <label for="sigWidth">Width</label>
              <input
                #widthInput
                type="number"
                id="sigWidth"
                min="10"
                step="0.1"
                [disabled]="!hasDoc()"
                [value]="signatures.addWidth()"
                (input)="setSize('addWidth', widthInput.value)"
              />
            </div>
            <div>
              <label for="sigHeight">Height</label>
              <input
                #heightInput
                type="number"
                id="sigHeight"
                min="10"
                step="0.1"
                [disabled]="!hasDoc()"
                [value]="signatures.addHeight()"
                (input)="setSize('addHeight', heightInput.value)"
              />
            </div>
          </div>

          <div class="checkbox-group-row">
            <label class="checkbox-group checkbox-group-block" for="sigRequired">
              <div class="checkbox-group-main">
                <input
                  #requiredInput
                  type="checkbox"
                  id="sigRequired"
                  [disabled]="!hasDoc()"
                  [checked]="signatures.addRequired()"
                  (change)="signatures.setAddForm({ addRequired: requiredInput.checked })"
                />
                <span>Required Field</span>
              </div>
            </label>
          </div>

          <div class="placement-hint" id="placementHint" [class.is-active]="signatures.isPlacing()">
            <span class="icon icon-info-circle-notif placement-hint-icon" aria-hidden="true"></span>
            <span class="placement-hint-text" id="placementHintText">
              @if (signatures.isPlacing()) {
                {{ placingHint }}
              } @else {
                Name the field above, then click <strong>Place on Document</strong> and click anywhere on the PDF to drop it. Drag it to reposition, or
                drag the coral handle to resize.
              }
            </span>
          </div>

          <button
            type="button"
            id="btnPlaceField"
            class="btn btn-primary btn-block"
            [disabled]="!signatures.canPlace()"
            [hidden]="signatures.isPlacing()"
            (click)="signatures.startPlacing()"
          >
            <span class="icon icon-pen" aria-hidden="true" id="btnPlaceFieldIcon"></span> <span id="btnPlaceFieldLabel">Place on Document</span>
          </button>
          <div class="add-sig-actions" id="addSigActions" [hidden]="!signatures.isPlacing()">
            <button type="button" id="btnCancelPlace" class="btn btn-danger btn-block" [disabled]="!hasDoc()" (click)="signatures.clearPendingField()">
              <span class="icon icon-close" aria-hidden="true"></span> Cancel Placement
            </button>
          </div>
        </form>
        <div id="actionStatus" class="status-text {{ signatures.status()?.type ?? '' }}">{{ signatures.status()?.message }}</div>
      </div>

      <div
        class="sig-tab-panel templates-panel"
        id="sigTabPanelTemplates"
        data-sig-tab-panel="templates"
        role="tabpanel"
        aria-labelledby="sigTabTemplates"
        [hidden]="tab() !== 'templates'"
      >
        <p class="revisions-hint">Reusable field lists saved in this browser. Place your fields on the document, then drag them in here to keep them for next time.</p>
        <div class="template-picker" id="templatePicker" [hidden]="!templates.hasTemplates()">
          <label for="templateSelect">Active template</label>
          <div class="template-picker-row">
            <div class="select-field">
              <select #templateSelect id="templateSelect" (change)="templates.selectTemplate(templateSelect.value)">
                @for (t of templates.templates(); track t.id) {
                  <option [value]="t.id" [selected]="t.id === selected()?.id">{{ t.name }} · {{ t.items.length }} field{{ t.items.length === 1 ? '' : 's' }}</option>
                }
              </select>
              <span class="icon icon-chevron-down select-field-arrow" aria-hidden="true"></span>
            </div>
            <button
              type="button"
              id="btnRenameTemplate"
              class="icon-btn"
              aria-label="Rename template"
              title="Rename template"
              [disabled]="!templates.hasTemplates()"
              (click)="rename()"
            >
              <span class="icon icon-edit2" aria-hidden="true"></span>
            </button>
            <button
              type="button"
              id="btnDeleteTemplate"
              class="icon-btn icon-btn-danger template-delete-btn"
              aria-label="Delete template"
              title="Delete template"
              [disabled]="!templates.hasTemplates()"
              (click)="remove()"
            >
              <span class="icon icon-close" aria-hidden="true"></span>
            </button>
          </div>
        </div>

        <div
          class="template-dropzone"
          id="templateDropzone"
          [class.is-drop-target]="templates.dropzoneActive()"
          (dragover)="onDropzoneOver($event)"
          (dragleave)="onDropzoneLeave($event)"
          (drop)="onDropzoneDrop($event)"
        >
          <div class="template-dropzone-idle" aria-hidden="true">
            <span class="icon icon-layers" aria-hidden="true"></span>
            <span>Drag a field off the document here to save it</span>
          </div>
          <div class="template-dropzone-cue" aria-hidden="true">
            <span class="icon icon-layers" aria-hidden="true"></span>
            <span id="templateDropzoneCueText">{{ selected() ? 'Drop to add to “' + selected()?.name + '”' : 'Drop to start a new template' }}</span>
          </div>
        </div>

        <details class="template-item-list-details" id="templateItemListDetails" [open]="templates.itemListOpen()" (toggle)="onListToggle($event)">
          <summary class="template-item-list-summary">
            <span class="icon icon-chevron-right template-item-list-caret" aria-hidden="true"></span>
            <span id="templateItemListSummaryText">Saved fields{{ templates.hasTemplates() ? ' (' + templates.selectedCount() + ')' : '' }}</span>
          </summary>
          <div class="template-item-list" id="templateItemList">
            @if (!templates.hasTemplates()) {
              <div class="template-empty">
                <span class="icon icon-layers template-empty-icon" aria-hidden="true"></span>
                <p class="template-empty-title">No templates yet.</p>
                <p class="template-empty-hint">Create one, then drag fields off your document into it.</p>
              </div>
            } @else if (!templates.selectedCount()) {
              <div class="template-empty">
                <span class="icon icon-layers template-empty-icon" aria-hidden="true"></span>
                <p class="template-empty-title">Nothing saved here yet.</p>
                <p class="template-empty-hint">
                  {{
                    hasDoc()
                      ? 'Place your fields on the document, then drag each one in here by its corner handle.'
                      : 'Upload a document and place your fields, then drag them in here to save them.'
                  }}
                </p>
              </div>
            } @else if (selected(); as template) {
              @for (item of template.items; track item.id) {
                <div
                  class="template-item-row"
                  [attr.data-item-id]="item.id"
                  [draggable]="templates.rowsDraggable()"
                  [class.is-draggable]="templates.rowsDraggable()"
                  [class.is-dragging]="templates.draggingTemplateItem()?.item?.id === item.id"
                  [title]="templates.rowsDraggable() ? summary(item) + '\\nDrag onto the document to place it' : summary(item)"
                  (dragstart)="onItemDragStart($event, item, template)"
                  (dragend)="templates.endTemplateItemDrag()"
                >
                  <span class="icon {{ item.type === 'text' ? 'icon-file-text' : 'icon-pen' }} template-item-icon" aria-hidden="true"></span>
                  <span class="template-item-name" [title]="item.name">{{ item.name }}</span>
                  <!-- The row is the drag handle, so a mousedown on either button must not start one. -->
                  <div class="template-item-actions" draggable="false" (mousedown)="$event.stopPropagation()">
                    <button
                      type="button"
                      class="icon-btn template-item-btn"
                      [attr.aria-label]="'Move or copy ' + item.name + ' to another template'"
                      [disabled]="templates.templates().length < 2"
                      [title]="
                        templates.templates().length > 1
                          ? 'Move or copy this field into another template'
                          : 'Create a second template first to move or copy fields between lists'
                      "
                      (click)="templates.openMoveModal(item.id, template.id)"
                    >
                      <span class="icon icon-arrow-right" aria-hidden="true"></span>
                    </button>
                    <button
                      type="button"
                      class="icon-btn icon-btn-danger template-item-btn"
                      [attr.aria-label]="'Remove ' + item.name + ' from this template'"
                      title="Remove this field from the template"
                      (click)="templates.openRemoveItemModal(template.id, item.id)"
                    >
                      <span class="icon icon-close" aria-hidden="true"></span>
                    </button>
                  </div>
                </div>
              }
            }
          </div>
        </details>

        <input type="checkbox" id="templateAutoPlace" class="sr-only" [checked]="templates.autoPlace()" [disabled]="!templates.hasTemplates()" />
        <div class="template-mode-tabs" id="templateModeTabs" role="tablist" aria-label="Placement mode" [class.is-disabled]="!templates.hasTemplates()">
          <button
            type="button"
            class="template-mode-tab"
            id="templateModeManual"
            data-template-mode="manual"
            role="tab"
            [class.active]="!templates.autoPlace()"
            [attr.aria-selected]="!templates.autoPlace()"
            [disabled]="!templates.hasTemplates()"
            (click)="templates.setAutoPlace(false)"
          >
            <span class="icon icon-move" aria-hidden="true"></span> Manual place
          </button>
          <button
            type="button"
            class="template-mode-tab"
            id="templateModeAuto"
            data-template-mode="auto"
            role="tab"
            [class.active]="templates.autoPlace()"
            [attr.aria-selected]="templates.autoPlace()"
            [disabled]="!templates.hasTemplates()"
            (click)="templates.setAutoPlace(true)"
          >
            <span class="icon icon-layers" aria-hidden="true"></span> Automatic place
          </button>
        </div>
        <p class="modal-hint settings-hint" id="templateModeHint">
          {{
            templates.autoPlace()
              ? 'Places every field in the list back at the exact page and position it was saved from, in one go.'
              : 'Drag items from the saved list onto the document to place them one at a time.'
          }}
        </p>

        <p class="template-place-hint" id="templatePlaceHint" [hidden]="hasDoc() || !templates.hasTemplates()">Upload a document to place these fields on it.</p>
        <button
          type="button"
          id="btnPlaceTemplate"
          class="btn btn-primary btn-block btn-place-template"
          [hidden]="!templates.autoPlace()"
          [disabled]="!hasDoc() || !templates.selectedCount()"
          (click)="templates.placeTemplateBatch()"
        >
          <span class="icon icon-layers" aria-hidden="true"></span>
          <span id="btnPlaceTemplateLabel">{{ templates.selectedCount() === 1 ? 'Place 1 field' : 'Place all ' + templates.selectedCount() + ' fields' }}</span>
        </button>
      </div>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    id: 'sectionSignatures',
    class: 'section-panel active section-panel-enter',
    'data-section-panel': 'signatures',
  },
})
export class SignaturesSection {
  protected readonly ui = inject(UiService);
  protected readonly doc = inject(DocumentStore);
  protected readonly signatures = inject(SignaturesStore);
  protected readonly templates = inject(TemplatesStore);
  private readonly settings = inject(SettingsService);
  private readonly viewer = inject(ViewerService);
  private readonly document = inject(DOCUMENT);

  protected readonly placingHint = PLACEMENT_HINT_PLACING;
  protected readonly summary = templateItemSummary;

  protected readonly hasDoc = computed(() => !!this.doc.pdfDoc());
  protected readonly tab = this.ui.signatureTab;
  protected readonly templatesEnabled = computed(() => this.settings.effective().templatesEnabled);
  protected readonly selected = this.templates.selectedTemplate;

  protected readonly hero = computed<HeroModel | null>(() => {
    if (!this.doc.activeFile()) return null;
    const { total, unsigned, signed } = this.signatures.hero();
    return {
      kind: 'signature',
      icon: 'icon-pen',
      label: `${total} signature field${total === 1 ? '' : 's'}`,
      subtitle: total ? `${unsigned} unsigned · ${signed} signed` : 'Add one below, then place it on the page',
      badge: !total
        ? { type: 'pill', text: 'None yet', tone: 'neutral' }
        : unsigned
          ? { type: 'pill', text: `${unsigned} to sign`, tone: 'pending' }
          : { type: 'pill', text: 'All signed', tone: 'positive' },
    };
  });

  protected setTab(tab: SignatureTab): void {
    this.ui.signatureTab.set(tab);
  }

  protected setSize(key: 'addWidth' | 'addHeight', raw: string): void {
    const value = parseFloat(raw);
    // A half-typed number isn't written back (that would overwrite the input mid-edit).
    if (Number.isFinite(value)) this.signatures.setAddForm({ [key]: value });
  }

  protected rename(): void {
    const id = this.selected()?.id;
    if (id) this.templates.openNameModal(id);
  }

  protected remove(): void {
    const id = this.selected()?.id;
    if (id) this.templates.openDeleteModal(id);
  }

  protected onListToggle(event: Event): void {
    const open = (event.target as HTMLDetailsElement).open;
    if (open !== this.templates.itemListOpen()) this.templates.setItemListOpen(open);
  }

  // ---- Capture: a field dragged off the page into the panel ----

  protected onDropzoneOver(event: DragEvent): void {
    if (!this.templates.draggingDocumentFieldUid()) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    if (!this.templates.dropzoneActive()) this.templates.setDropzoneActive(true);
  }

  protected onDropzoneLeave(event: DragEvent): void {
    if (!this.templates.draggingDocumentFieldUid()) return;
    const related = event.relatedTarget;
    if (related instanceof Node && (event.currentTarget as HTMLElement).contains(related)) return;
    this.templates.setDropzoneActive(false);
  }

  protected onDropzoneDrop(event: DragEvent): void {
    const uid = this.templates.draggingDocumentFieldUid();
    if (!uid) return;
    event.preventDefault();
    this.templates.dropCapturedField();
    // The capture is done: land the panel back on its default view.
    if (this.signatures.activeFieldUid() === uid) this.signatures.deselect();
  }

  // ---- Manual placement: an item dragged from the panel onto the page ----

  protected onItemDragStart(event: DragEvent, item: TemplateItem, template: SignatureTemplate): void {
    if (!this.templates.rowsDraggable() || !event.dataTransfer) return;
    this.templates.beginTemplateItemDrag(item, template.id);
    event.dataTransfer.effectAllowed = 'copy';
    event.dataTransfer.setData(TEMPLATE_DRAG_MIME, item.id);
    // Some browsers need a plain-text payload to start a drag at all.
    event.dataTransfer.setData('text/plain', item.name);
    this.setDragImage(event.dataTransfer, item);
  }

  /** A field-sized ghost at the current zoom, so the drop lands where it looks like it will. */
  private setDragImage(dataTransfer: DataTransfer, item: TemplateItem): void {
    const viewport = this.viewer.viewport();
    const scaleX = viewport?.scaleX ?? viewport?.scale ?? 1;
    const scaleY = viewport?.scaleY ?? scaleX;
    const MIN_PX = 32;
    const width = Math.max(MIN_PX, Math.round(item.width * scaleX));
    const height = Math.max(MIN_PX, Math.round(item.height * scaleY));

    const ghost = this.document.createElement('div');
    ghost.className = `field-overlay${item.required ? ' required' : ''}`;
    Object.assign(ghost.style, { position: 'fixed', left: '-9999px', top: '-9999px', width: `${width}px`, height: `${height}px` });
    const icon = this.document.createElement('span');
    icon.className = `icon ${item.type === 'text' ? 'icon-file-text' : 'icon-pen'}`;
    icon.setAttribute('aria-hidden', 'true');
    const label = this.document.createElement('div');
    label.className = 'field-label';
    label.style.display = 'block';
    label.textContent = item.name;
    ghost.append(icon, label);

    this.document.body.appendChild(ghost);
    dataTransfer.setDragImage(ghost, width / 2, height / 2);
    // The browser snapshots the drag image synchronously.
    setTimeout(() => ghost.remove(), 0);
  }
}
