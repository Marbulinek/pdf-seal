import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { TemplatesStore } from '../../features/signatures/templates.store';
import { isBackdropClick } from './backdrop-click';

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
