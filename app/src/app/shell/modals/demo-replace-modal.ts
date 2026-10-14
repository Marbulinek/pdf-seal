import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { SignaturesStore } from '../../features/signatures/signatures.store';
import { TourService } from '../../features/tour/tour.service';
import { isBackdropClick } from './backdrop-click';

@Component({
  selector: 'div[appDemoReplaceModal]',
  template: `
    <div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="demoReplaceModalTitle">
      <div class="modal-header">
        <h3 id="demoReplaceModalTitle">Replace the open document?</h3>
        <button type="button" class="modal-close" id="closeDemoReplaceModalBtn" aria-label="Close" (click)="tour.cancelDemoReplace()">
          <span class="icon icon-close" aria-hidden="true"></span>
        </button>
      </div>
      <p class="modal-hint">
        Loading the sample document replaces the PDF you have open now, and clears its version history from this browser (version history
        lives only locally, never on the server).
      </p>
      <p class="modal-hint" id="demoReplaceUnappliedNote" [hidden]="signatures.pendingCount() === 0">
        You also have unapplied field changes on the current document — those will be lost too.
      </p>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" id="cancelDemoReplaceBtn" (click)="tour.cancelDemoReplace()">Cancel</button>
        <button type="button" class="btn btn-primary" id="confirmDemoReplaceBtn" (click)="tour.confirmDemoReplace()">Replace document</button>
      </div>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    id: 'demoReplaceModal',
    class: 'modal-backdrop',
    '[class.is-open]': 'tour.demoReplacePending() !== null',
    '[attr.aria-hidden]': 'tour.demoReplacePending() === null',
    '(click)': 'onBackdrop($event)',
  },
})
export class DemoReplaceModal {
  protected readonly tour = inject(TourService);
  protected readonly signatures = inject(SignaturesStore);

  protected onBackdrop(event: MouseEvent): void {
    if (isBackdropClick(event)) this.tour.cancelDemoReplace();
  }
}
