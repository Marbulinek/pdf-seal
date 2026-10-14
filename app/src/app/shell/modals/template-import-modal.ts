import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { plural } from '../../core/util/format';
import { TemplatesStore } from '../../features/signatures/templates.store';
import { isBackdropClick } from './backdrop-click';

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
