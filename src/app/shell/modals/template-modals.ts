import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, untracked, viewChild } from '@angular/core';
import { plural, pluralize } from '../../core/util/format';
import { TemplatesStore } from '../../features/signatures/templates.store';
import { isBackdropClick } from './simple-modals';

/** Create / rename a signature template -- the only text a template needs. */
@Component({
  selector: 'div[appTemplateNameModal]',
  template: `
    <div class="modal-box template-name-modal-box" role="dialog" aria-modal="true" aria-labelledby="templateNameTitle">
      <div class="modal-header">
        <h3 id="templateNameTitle">{{ editing() ? 'Rename template' : 'New signature template' }}</h3>
        <button type="button" class="modal-close" id="closeTemplateNameBtn" aria-label="Close" (click)="templates.closeNameModal()">
          <span class="icon icon-close" aria-hidden="true"></span>
        </button>
      </div>
      <p class="modal-hint" id="templateNameHint">{{ hint() }}</p>

      <div class="form-group">
        <label for="templateNameInput">Template name</label>
        <input
          #nameInput
          type="text"
          id="templateNameInput"
          placeholder="e.g. Contract — 2 signers"
          autocomplete="off"
          spellcheck="false"
          (keydown.enter)="submit($event)"
        />
      </div>

      <div class="modal-status" [class.error]="!!templates.nameModal().status" id="templateNameStatus">{{ templates.nameModal().status }}</div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" id="cancelTemplateNameBtn" (click)="templates.closeNameModal()">Cancel</button>
        <button type="button" class="btn btn-primary" id="saveTemplateNameBtn" (click)="submit()">
          <span class="icon icon-check" aria-hidden="true"></span> <span id="saveTemplateNameLabel">{{ editing() ? 'Save name' : 'Create template' }}</span>
        </button>
      </div>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    id: 'templateNameModal',
    class: 'modal-backdrop',
    '[class.is-open]': 'templates.nameModal().open',
    '[attr.aria-hidden]': '!templates.nameModal().open',
    '(click)': 'onBackdrop($event)',
  },
})
export class TemplateNameModal {
  protected readonly templates = inject(TemplatesStore);
  private readonly nameInput = viewChild.required<ElementRef<HTMLInputElement>>('nameInput');

  protected readonly editing = computed(() => {
    const id = this.templates.nameModal().editingId;
    return id ? (this.templates.templates().find((t) => t.id === id) ?? null) : null;
  });

  protected readonly hint = computed(() => {
    if (this.editing()) return 'Only the label changes — the fields saved in this template stay exactly as they are.';
    const captured = this.templates.capturedFieldName();
    return captured
      ? `Name the template and "${captured}" goes straight into it. Drag your other fields in the same way to fill it out.`
      : 'Give the template a name. To fill it, place fields on your document as usual, then drag each one into the Signature Templates panel.';
  });

  constructor() {
    effect(() => {
      if (!this.templates.nameModal().open) return;
      untracked(() => {
        const el = this.nameInput().nativeElement;
        el.value = this.editing()?.name ?? '';
        setTimeout(() => {
          el.focus();
          el.select();
        }, 0);
      });
    });
  }

  protected submit(event?: Event): void {
    event?.preventDefault();
    this.templates.submitTemplateName(this.nameInput().nativeElement.value);
  }

  protected onBackdrop(event: MouseEvent): void {
    if (isBackdropClick(event)) this.templates.closeNameModal();
  }
}

/** Move or copy one saved field into another template. */
@Component({
  selector: 'div[appTemplateMoveItemModal]',
  template: `
    <div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="templateMoveItemTitle">
      <div class="modal-header">
        <h3 id="templateMoveItemTitle">Move or copy field</h3>
        <button type="button" class="modal-close" id="closeTemplateMoveItemBtn" aria-label="Close" (click)="templates.closeMoveModal()">
          <span class="icon icon-close" aria-hidden="true"></span>
        </button>
      </div>
      <p class="modal-hint">
        Move or copy <strong id="templateMoveItemName">{{ itemName() }}</strong> from
        <strong id="templateMoveItemSource">{{ source()?.name }}</strong> into another template.
      </p>
      <div class="form-group">
        <label for="templateMoveTargetSelect">Target template</label>
        <div class="select-field">
          <select #target id="templateMoveTargetSelect">
            @for (t of targets(); track t.id) {
              <option [value]="t.id">{{ t.name }}</option>
            }
          </select>
          <span class="icon icon-chevron-down select-field-arrow" aria-hidden="true"></span>
        </div>
      </div>
      <div class="modal-status" id="templateMoveItemStatus">{{ templates.moveModal()?.status }}</div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" id="cancelTemplateMoveItemBtn" (click)="templates.closeMoveModal()">Cancel</button>
        <button type="button" class="btn btn-ghost" id="confirmTemplateCopyItemBtn" (click)="templates.confirmMove('copy', target.value)">
          <span class="icon icon-copy" aria-hidden="true"></span> Copy
        </button>
        <button type="button" class="btn btn-primary" id="confirmTemplateMoveItemBtn" (click)="templates.confirmMove('move', target.value)">
          <span class="icon icon-move" aria-hidden="true"></span> Move
        </button>
      </div>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    id: 'templateMoveItemModal',
    class: 'modal-backdrop',
    '[class.is-open]': '!!templates.moveModal()',
    '[attr.aria-hidden]': '!templates.moveModal()',
    '(click)': 'onBackdrop($event)',
  },
})
export class TemplateMoveItemModal {
  protected readonly templates = inject(TemplatesStore);

  protected readonly source = computed(() => {
    const id = this.templates.moveModal()?.sourceTemplateId;
    return this.templates.templates().find((t) => t.id === id) ?? null;
  });
  protected readonly itemName = computed(() => {
    const itemId = this.templates.moveModal()?.itemId;
    return this.source()?.items.find((i) => i.id === itemId)?.name || 'this field';
  });
  protected readonly targets = computed(() => {
    const sourceId = this.templates.moveModal()?.sourceTemplateId;
    return this.templates.templates().filter((t) => t.id !== sourceId);
  });

  protected onBackdrop(event: MouseEvent): void {
    if (isBackdropClick(event)) this.templates.closeMoveModal();
  }
}

/** Confirm deleting a whole template (immediate, not staged). */
@Component({
  selector: 'div[appDeleteTemplateModal]',
  template: `
    <div class="modal-box remove-field-modal-box" role="dialog" aria-modal="true" aria-labelledby="deleteTemplateModalTitle">
      <div class="modal-header">
        <h3 id="deleteTemplateModalTitle">Delete Template</h3>
        <button type="button" class="modal-close" id="closeDeleteTemplateModalBtn" aria-label="Close" (click)="templates.closeDeleteModal()">
          <span class="icon icon-close" aria-hidden="true"></span>
        </button>
      </div>
      <div class="remove-field-body">
        <img class="remove-field-seal" src="/assets/images/seal-curious.webp" alt="" aria-hidden="true" />
        <div class="remove-field-text">
          <p class="modal-hint remove-field-hint">
            Delete the template <strong id="deleteTemplateModalName">{{ template()?.name }}</strong><span id="deleteTemplateModalCount">{{ countText() }}</span>?
          </p>
          <p class="modal-hint remove-field-hint">
            Unlike field edits, this isn't staged — the template is removed from this browser straight away and can't be brought back.
          </p>
        </div>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" id="cancelDeleteTemplateBtn" (click)="templates.closeDeleteModal()">Cancel</button>
        <button type="button" class="btn btn-danger" id="confirmDeleteTemplateBtn" (click)="templates.confirmDelete()">Delete Template</button>
      </div>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    id: 'deleteTemplateModal',
    class: 'modal-backdrop',
    '[class.is-open]': '!!templates.deleteTemplateId()',
    '[attr.aria-hidden]': '!templates.deleteTemplateId()',
    '(click)': 'onBackdrop($event)',
  },
})
export class DeleteTemplateModal {
  protected readonly templates = inject(TemplatesStore);
  protected readonly template = computed(() => this.templates.templates().find((t) => t.id === this.templates.deleteTemplateId()) ?? null);
  protected readonly countText = computed(() => {
    const n = this.template()?.items.length ?? 0;
    return n ? ` and its ${n} field${plural(n)}` : '';
  });

  protected onBackdrop(event: MouseEvent): void {
    if (isBackdropClick(event)) this.templates.closeDeleteModal();
  }
}

/** Confirm removing one saved field from a template. */
@Component({
  selector: 'div[appRemoveTemplateItemModal]',
  template: `
    <div class="modal-box remove-field-modal-box" role="dialog" aria-modal="true" aria-labelledby="removeTemplateItemModalTitle">
      <div class="modal-header">
        <h3 id="removeTemplateItemModalTitle">Remove field</h3>
        <button type="button" class="modal-close" id="closeRemoveTemplateItemModalBtn" aria-label="Close" (click)="templates.closeRemoveItemModal()">
          <span class="icon icon-close" aria-hidden="true"></span>
        </button>
      </div>
      <div class="remove-field-body">
        <img class="remove-field-seal" src="/assets/images/seal-curious.webp" alt="" aria-hidden="true" />
        <div class="remove-field-text">
          <p class="modal-hint remove-field-hint">
            Remove <strong id="removeTemplateItemModalName">{{ item()?.name || 'this field' }}</strong> from
            <strong id="removeTemplateItemModalTemplateName">{{ template()?.name }}</strong>?
          </p>
          <p class="modal-hint remove-field-hint">This only removes it from the template — nothing already placed on your document is affected.</p>
        </div>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" id="cancelRemoveTemplateItemBtn" (click)="templates.closeRemoveItemModal()">Cancel</button>
        <button type="button" class="btn btn-danger" id="confirmRemoveTemplateItemBtn" (click)="templates.confirmRemoveItem()">Remove</button>
      </div>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    id: 'removeTemplateItemModal',
    class: 'modal-backdrop',
    '[class.is-open]': '!!templates.removeItem()',
    '[attr.aria-hidden]': '!templates.removeItem()',
    '(click)': 'onBackdrop($event)',
  },
})
export class RemoveTemplateItemModal {
  protected readonly templates = inject(TemplatesStore);
  protected readonly template = computed(() => this.templates.templates().find((t) => t.id === this.templates.removeItem()?.templateId) ?? null);
  protected readonly item = computed(() => this.template()?.items.find((i) => i.id === this.templates.removeItem()?.itemId) ?? null);

  protected onBackdrop(event: MouseEvent): void {
    if (isBackdropClick(event)) this.templates.closeRemoveItemModal();
  }
}

/** Before an auto-placement batch onto a document that already has unsigned signature fields. */
@Component({
  selector: 'div[appPlaceTemplateCleanupModal]',
  template: `
    <div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="placeTemplateCleanupTitle">
      <div class="modal-header">
        <h3 id="placeTemplateCleanupTitle">Existing fields on this document</h3>
        <button type="button" class="modal-close" id="closePlaceTemplateCleanupBtn" aria-label="Close" (click)="templates.closeCleanup()">
          <span class="icon icon-close" aria-hidden="true"></span>
        </button>
      </div>
      <p class="modal-hint" id="placeTemplateCleanupHint">{{ hint() }}</p>
      <div class="place-template-choices" id="placeTemplateCleanupChoices">
        @for (opt of options(); track opt.value) {
          <label class="place-template-choice" [class.is-selected]="opt.value === selected()" [class.is-disabled]="!!opt.disabled">
            <input
              type="radio"
              name="placeTemplateCleanup"
              [value]="opt.value"
              [checked]="opt.value === selected()"
              [disabled]="!!opt.disabled"
              (change)="templates.setCleanupValue(opt.value)"
            />
            <span>
              <strong>{{ opt.title }}</strong>
              <span class="place-template-choice-meta">{{ opt.desc }}</span>
            </span>
          </label>
        }
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" id="cancelPlaceTemplateCleanupBtn" (click)="templates.closeCleanup()">Cancel</button>
        <button type="button" class="btn btn-primary" id="confirmPlaceTemplateCleanupBtn" (click)="templates.confirmCleanup()">Continue</button>
      </div>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    id: 'placeTemplateCleanupModal',
    class: 'modal-backdrop',
    '[class.is-open]': '!!templates.cleanup()',
    '[attr.aria-hidden]': '!templates.cleanup()',
    '(click)': 'onBackdrop($event)',
  },
})
export class PlaceTemplateCleanupModal {
  protected readonly templates = inject(TemplatesStore);
  protected readonly options = computed(() => this.templates.cleanupOptions());
  /** Falls back to "keep" when the picked option is disabled. */
  protected readonly selected = computed(() => {
    const value = this.templates.cleanup()?.value ?? 'none';
    return this.options().some((o) => o.value === value && !o.disabled) ? value : 'none';
  });
  protected readonly hint = computed(() => {
    const cleanup = this.templates.cleanup();
    if (!cleanup) return '';
    const name = this.templates.templates().find((t) => t.id === cleanup.templateId)?.name;
    return `“${name}” is about to add to a document that already has ${pluralize(cleanup.docSig, 'unsigned signature field')}. Choose what happens to them.`;
  });

  protected onBackdrop(event: MouseEvent): void {
    if (isBackdropClick(event)) this.templates.closeCleanup();
  }
}

/** Confirm how a loaded template backup applies: add to or replace the current ones. */
@Component({
  selector: 'div[appTemplateImportModal]',
  template: `
    <div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="templateImportTitle">
      <div class="modal-header">
        <h3 id="templateImportTitle">Load templates</h3>
        <button type="button" class="modal-close" id="closeTemplateImportBtn" aria-label="Close" (click)="templates.closeImportModal()">
          <span class="icon icon-close" aria-hidden="true"></span>
        </button>
      </div>
      <p class="modal-hint" id="templateImportSummary">{{ summary() }}</p>
      <div class="template-import-preview" id="templateImportPreview">
        @for (t of templates.importModal()?.store?.templates ?? []; track t.id) {
          <div class="template-import-row">
            <span class="template-import-name" [title]="t.name">{{ t.name }}</span>
            <span class="template-item-badge">{{ t.items.length }} field{{ plural(t.items.length) }}</span>
          </div>
        }
      </div>
      <p class="modal-hint settings-hint settings-hint-flush" id="templateImportChoiceHint">{{ choiceHint() }}</p>
      <div class="modal-status" id="templateImportStatus"></div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" id="cancelTemplateImportBtn" (click)="templates.closeImportModal()">Cancel</button>
        <button type="button" class="btn btn-danger" id="btnTemplateImportReplace" (click)="templates.applyImport('replace')">Replace all</button>
        <button type="button" class="btn btn-primary" id="btnTemplateImportMerge" (click)="templates.applyImport('merge')">Add to my templates</button>
      </div>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    id: 'templateImportModal',
    class: 'modal-backdrop',
    '[class.is-open]': '!!templates.importModal()',
    '[attr.aria-hidden]': '!templates.importModal()',
    '(click)': 'onBackdrop($event)',
  },
})
export class TemplateImportModal {
  protected readonly templates = inject(TemplatesStore);
  protected readonly plural = plural;

  protected readonly summary = computed(() => {
    const pending = this.templates.importModal();
    if (!pending) return '';
    const templateCount = pending.store.templates.length;
    const fieldCount = this.templates.countFields(pending.store);
    return `${pending.fileName} contains ${templateCount} template${plural(templateCount)} with ${fieldCount} field${plural(fieldCount)}:`;
  });

  protected readonly choiceHint = computed(() => {
    const existing = this.templates.templates().length;
    return existing
      ? `Add keeps the ${existing} template${plural(existing)} you already have and appends these, renaming any whose name clashes. Replace all discards your current templates — that can't be undone.`
      : 'You have no templates yet, so either button gives the same result.';
  });

  protected onBackdrop(event: MouseEvent): void {
    if (isBackdropClick(event)) this.templates.closeImportModal();
  }
}
