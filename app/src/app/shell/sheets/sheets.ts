import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { UiService } from '../../core/ui.service';
import { CertificatesStore } from '../../features/certificates/certificates.store';
import { OverviewStore } from '../../features/overview/overview.store';
import { SignaturesStore } from '../../features/signatures/signatures.store';
import { VersionsStore } from '../../features/versions/versions.store';
import { CertificateModifySheet } from './certificate-modify-sheet';
import { CertificateSheet } from './certificate-sheet';
import { CertificateTimelineSheet } from './certificate-timeline-sheet';
import { CompareSheet } from './compare-sheet';
import { EditSheet } from './edit-sheet';
import { OverviewSheet } from './overview-sheet';

/**
 * The sheets that slide over the right-hand column, each with its mobile
 * bottom-sheet scrim. Only one is open at a time.
 */
@Component({
  selector: 'app-sheets',
  imports: [EditSheet, CompareSheet, OverviewSheet, CertificateSheet, CertificateModifySheet, CertificateTimelineSheet],
  template: `
    <div class="edit-sheet-scrim" id="editSheetScrim" [class.is-open]="ui.sheets.edit()" (click)="signatures.deselect()"></div>
    <aside appEditSheet></aside>

    <div class="edit-sheet-scrim" id="revisionsCompareSheetScrim" [class.is-open]="ui.sheets.compare()" (click)="versions.closeCompareSheet()"></div>
    <aside appCompareSheet></aside>

    <div class="edit-sheet-scrim" id="overviewSheetScrim" [class.is-open]="ui.sheets.overview()" (click)="overview.closeSheet()"></div>
    <aside appOverviewSheet></aside>

    <div class="edit-sheet-scrim" id="certificateSheetScrim" [class.is-open]="ui.sheets.certificate()" (click)="certificates.closeCertificateSheet()"></div>
    <aside appCertificateSheet></aside>

    <div
      class="edit-sheet-scrim"
      id="certificateModifySheetScrim"
      [class.is-open]="ui.sheets.certificateModify()"
      (click)="certificates.closeModifySheet()"
    ></div>
    <aside appCertificateModifySheet></aside>

    <div
      class="edit-sheet-scrim"
      id="certificateTimelineSheetScrim"
      [class.is-open]="ui.sheets.certificateTimeline()"
      (click)="certificates.closeTimelineSheet()"
    ></div>
    <aside appCertificateTimelineSheet></aside>
  `,
  styleUrl: './sheets.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Sheets {
  protected readonly ui = inject(UiService);
  protected readonly signatures = inject(SignaturesStore);
  protected readonly versions = inject(VersionsStore);
  protected readonly overview = inject(OverviewStore);
  protected readonly certificates = inject(CertificatesStore);
}
