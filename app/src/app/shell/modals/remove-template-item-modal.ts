import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { TemplatesStore } from '../../features/signatures/templates.store';
import { isBackdropClick } from './backdrop-click';

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
