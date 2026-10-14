import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { UiService } from '../../core/ui.service';
import { SignaturesStore } from '../../features/signatures/signatures.store';
import { isBackdropClick } from './backdrop-click';

@Component({
  selector: 'div[appRemoveFieldModal]',
  template: `
    <div class="modal-box remove-field-modal-box" role="dialog" aria-modal="true" aria-labelledby="removeFieldModalTitle">
      <div class="modal-header">
        <h3 id="removeFieldModalTitle">Remove Field</h3>
        <button type="button" class="modal-close" id="closeRemoveFieldModalBtn" aria-label="Close" (click)="close()">
          <span class="icon icon-close" aria-hidden="true"></span>
        </button>
      </div>
      <div class="remove-field-body">
        <img class="remove-field-seal" src="/assets/images/seal-curious.webp" alt="" aria-hidden="true" />
        <div class="remove-field-text">
          <p class="modal-hint remove-field-hint">
            Remove the field <strong id="removeFieldModalName">{{ ui.removeFieldName() }}</strong> from this document?
          </p>
          <p class="modal-hint remove-field-hint">This is staged like any other change — you can still <strong>Discard</strong> it before hitting Apply.</p>
        </div>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" id="cancelRemoveFieldBtn" (click)="close()">Cancel</button>
        <button type="button" class="btn btn-danger" id="confirmRemoveFieldBtn" (click)="confirm()">Remove Field</button>
      </div>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    id: 'removeFieldModal',
    class: 'modal-backdrop',
    '[class.is-open]': 'ui.removeFieldName() !== null',
    '(click)': 'onBackdrop($event)',
  },
})
export class RemoveFieldModal {
  protected readonly ui = inject(UiService);
  private readonly signatures = inject(SignaturesStore);

  protected close(): void {
    this.ui.removeFieldName.set(null);
  }

  protected confirm(): void {
    const name = this.ui.removeFieldName();
    this.close();
    if (name) this.signatures.removeFieldByName(name);
  }

  protected onBackdrop(event: MouseEvent): void {
    if (isBackdropClick(event)) this.close();
  }
}
