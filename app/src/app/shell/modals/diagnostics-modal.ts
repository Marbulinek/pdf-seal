import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { DocumentStore } from '../../core/document.store';
import { UiService } from '../../core/ui.service';
import { isBackdropClick } from './backdrop-click';

@Component({
  selector: 'div[appDiagnosticsModal]',
  template: `
    <div class="modal-box diagnostics-modal-box" role="dialog" aria-modal="true" aria-labelledby="diagnosticsModalTitle">
      <div class="modal-header">
        <h3 id="diagnosticsModalTitle">Diagnostics</h3>
        <button type="button" class="modal-close" id="closeDiagnosticsModalBtn" aria-label="Close" (click)="close()">
          <span class="icon icon-close" aria-hidden="true"></span>
        </button>
      </div>
      <p class="modal-hint">Include this Log ID when reporting a problem.</p>
      <div class="diagnostics-row">
        <span class="diagnostics-label">Log ID</span>
        <code class="diagnostics-value" id="diagnosticsLogId">{{ doc.documentSessionId() || 'No document open' }}</code>
      </div>
    </div>
  `,
  styleUrl: './diagnostics-modal.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    id: 'diagnosticsModal',
    class: 'modal-backdrop',
    '[class.is-open]': 'ui.diagnosticsModalOpen()',
    '[attr.aria-hidden]': '!ui.diagnosticsModalOpen()',
    '(click)': 'onBackdrop($event)',
  },
})
export class DiagnosticsModal {
  protected readonly ui = inject(UiService);
  protected readonly doc = inject(DocumentStore);

  protected close(): void {
    this.ui.diagnosticsModalOpen.set(false);
  }

  protected onBackdrop(event: MouseEvent): void {
    if (isBackdropClick(event)) this.close();
  }
}
