import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { DocumentService } from '../../core/document.service';
import { UiService } from '../../core/ui.service';
import { isBackdropClick } from './backdrop-click';

@Component({
  selector: 'div[appCloseDocumentModal]',
  template: `
    <div class="modal-box remove-field-modal-box" role="dialog" aria-modal="true" aria-labelledby="closeDocumentModalTitle">
      <div class="modal-header">
        <h3 id="closeDocumentModalTitle">Close Document</h3>
        <button type="button" class="modal-close" id="closeCloseDocumentModalBtn" aria-label="Close" (click)="close()">
          <span class="icon icon-close" aria-hidden="true"></span>
        </button>
      </div>
      <div class="remove-field-body">
        <img class="remove-field-seal" src="/assets/images/seal-curious.webp" alt="" aria-hidden="true" />
        <div class="remove-field-text">
          <p class="modal-hint remove-field-hint">Nothing is saved on a server — all changes will be lost.</p>
        </div>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" id="cancelCloseDocumentBtn" (click)="close()">Cancel</button>
        <button type="button" class="btn btn-danger" id="confirmCloseDocumentBtn" (click)="confirm()">Close Document</button>
      </div>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    id: 'closeDocumentModal',
    class: 'modal-backdrop',
    '[class.is-open]': 'ui.closeDocumentModalOpen()',
    '[attr.aria-hidden]': '!ui.closeDocumentModalOpen()',
    '(click)': 'onBackdrop($event)',
  },
})
export class CloseDocumentModal {
  protected readonly ui = inject(UiService);
  private readonly documents = inject(DocumentService);

  protected close(): void {
    this.ui.closeDocumentModalOpen.set(false);
  }

  protected confirm(): void {
    this.close();
    this.documents.closeActiveDocument();
  }

  protected onBackdrop(event: MouseEvent): void {
    if (isBackdropClick(event)) this.close();
  }
}
