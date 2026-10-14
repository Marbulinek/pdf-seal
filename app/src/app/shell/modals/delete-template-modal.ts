import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { plural } from '../../core/util/format';
import { TemplatesStore } from '../../features/signatures/templates.store';
import { isBackdropClick } from './backdrop-click';

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
