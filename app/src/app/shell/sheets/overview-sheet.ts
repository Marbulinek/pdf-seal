import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, untracked } from '@angular/core';
import { DocumentStore } from '../../core/document.store';
import { UiService } from '../../core/ui.service';
import { CertificatesStore } from '../../features/certificates/certificates.store';
import { overviewActionLabel, overviewSheetModel, type OverviewAction } from '../../features/overview/overview-model';
import { OverviewStore } from '../../features/overview/overview.store';
import { AppendNode } from '../../shared/append-node';
import { Evidence } from '../../shared/evidence';
import { OvFacts } from '../../shared/ov-facts';
import { OvFlags } from '../../shared/ov-flags';
import { OvHero } from '../../shared/ov-hero';
import { OvSectionTitle } from '../../shared/ov-section-title';

/** One object from the Overview list (signature, stamp, field, link, comment). */
@Component({
  selector: 'aside[appOverviewSheet]',
  imports: [OvHero, OvFacts, OvFlags, OvSectionTitle, Evidence, AppendNode],
  templateUrl: './overview-sheet.html',
  styleUrl: './overview-sheet.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    id: 'overviewSheet',
    class: 'edit-sheet',
    tabindex: '-1',
    'aria-labelledby': 'overviewSheetTitle',
    '[class.is-open]': 'ui.sheets.overview()',
    '[attr.aria-hidden]': '!ui.sheets.overview()',
  },
})
export class OverviewSheet {
  protected readonly ui = inject(UiService);
  protected readonly overview = inject(OverviewStore);
  private readonly certificates = inject(CertificatesStore);
  private readonly doc = inject(DocumentStore);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected readonly actionLabel = overviewActionLabel;

  protected readonly model = computed(() => {
    const item = this.overview.activeOverviewItem();
    return item ? overviewSheetModel(item, this.certificates.reportForActiveFile(), this.overview.sheetSettled(), this.certificates.trustResults()) : null;
  });

  /** Only the visuals drawn for this very item and file. */
  protected readonly visuals = computed(() => {
    const v = this.overview.visuals();
    const item = this.overview.activeItem();
    if (!v || !item || v.id !== `${item.kind}\u0000${item.key}` || v.file !== this.doc.activeFile()) return null;
    return v;
  });

  constructor() {
    effect(() => {
      const ref = this.overview.activeItem();
      if (ref && this.ui.sheets.overview()) untracked(() => this.host.nativeElement.focus({ preventScroll: true }));
    });
    // "Show changes after signing" is offered only for this file's native chain.
    effect(() => {
      const evidence = this.model()?.evidence;
      if (!evidence) return;
      untracked(() => evidence.forEach((r) => r.slot && this.overview.checkNativeChain(r.slot.to)));
    });
  }

  protected run(action: OverviewAction): void {
    switch (action.kind) {
      case 'open-certificates':
        this.overview.openInCertificates(action.field);
        break;
      case 'edit-signature':
        this.overview.editInSignatures(action.field);
        break;
      case 'copy':
        void this.certificates.copyText(action.text, 'Link');
        break;
      case 'goto-page':
        void this.overview.gotoPage(action.page);
        break;
    }
  }
}
