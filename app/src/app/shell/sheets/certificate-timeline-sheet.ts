import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, untracked } from '@angular/core';
import { UiService } from '../../core/ui.service';
import { validityTimeline } from '../../features/certificates/certificates-model';
import { CertificatesStore } from '../../features/certificates/certificates.store';
import { ValidityTimeline } from '../../shared/validity-timeline';

/** The validity timeline shown large enough to read comfortably. */
@Component({
  selector: 'aside[appCertificateTimelineSheet]',
  imports: [ValidityTimeline],
  template: `
    <div class="edit-sheet-header">
      <span class="edit-sheet-grabber" aria-hidden="true"></span>
      <span class="panel-dot dot-ocean"></span>
      <h3 id="certificateTimelineSheetTitle">Validity timeline</h3>
      <span class="edit-sheet-subject" id="certificateTimelineSheetSubject">{{ certificates.timelineField() ? 'Field: ' + certificates.timelineField() : '' }}</span>
      <button type="button" class="modal-close" id="btnCertificateTimelineSheetClose" aria-label="Close" (click)="certificates.closeTimelineSheet()">
        <span class="icon icon-close" aria-hidden="true"></span>
      </button>
    </div>
    <div class="edit-sheet-body" id="certificateTimelineBody">
      @if (timeline(); as t) {
        <app-validity-timeline [timeline]="t" [large]="true" />
      }
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    id: 'certificateTimelineSheet',
    class: 'edit-sheet',
    tabindex: '-1',
    'aria-labelledby': 'certificateTimelineSheetTitle',
    '[class.is-open]': 'ui.sheets.certificateTimeline()',
    '[attr.aria-hidden]': '!ui.sheets.certificateTimeline()',
  },
})
export class CertificateTimelineSheet {
  protected readonly ui = inject(UiService);
  protected readonly certificates = inject(CertificatesStore);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected readonly timeline = computed(() => {
    const report = this.certificates.report();
    const sig = report?.signatures.find((s) => s.fieldName === this.certificates.timelineField());
    if (!report || !sig) return null;
    const chain = report.chains.find((c) => c.id === sig.chainId);
    return validityTimeline(chain, sig, (id) => this.certificates.certById(id));
  });

  constructor() {
    effect(() => {
      if (this.ui.sheets.certificateTimeline() && this.certificates.timelineField()) {
        untracked(() => this.host.nativeElement.focus({ preventScroll: true }));
      }
    });
  }
}
