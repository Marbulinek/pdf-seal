import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, untracked } from '@angular/core';
import { SettingsService } from '../../core/settings.service';
import { UiService } from '../../core/ui.service';
import {
  CERT_ROLE_LABEL,
  certDisplayName,
  certExtensionRows,
  certOverviewSections,
  certStatusOf,
  certUsedBy,
  certValidityBar,
} from '../../features/certificates/certificates-model';
import { CertificatesStore, type CertificateTab } from '../../features/certificates/certificates.store';
import { SignaturesStore } from '../../features/signatures/signatures.store';
import { CertBadge } from '../../shared/ov-ui';
import { ValidationList } from '../../shared/validation-list';

const TABS: { id: CertificateTab; icon: string; label: string; panel: string }[] = [
  { id: 'overview', icon: 'icon-list', label: 'Overview', panel: 'certTabOverview' },
  { id: 'extensions', icon: 'icon-layers', label: 'Extensions', panel: 'certTabExtensions' },
  { id: 'validation', icon: 'icon-shield', label: 'Validation', panel: 'certTabValidation' },
  { id: 'raw', icon: 'icon-code', label: 'Raw', panel: 'certTabRaw' },
];

/** One certificate in full: a long, tabbed, scrollable document -- a sheet, not a modal. */
@Component({
  selector: 'aside[appCertificateSheet]',
  imports: [CertBadge, ValidationList],
  template: `
    @let cert = certificates.activeCert();
    <div class="edit-sheet-header">
      <span class="edit-sheet-grabber" aria-hidden="true"></span>
      <span class="panel-dot dot-ocean"></span>
      <h3 id="certificateSheetTitle">{{ cert ? displayName(cert) : 'Certificate' }}</h3>
      <span class="edit-sheet-subject" id="certificateSheetSubject">
        @if (cert) {
          {{ roleLabel() }} <app-cert-badge [status]="status()" />
        }
      </span>
      <button type="button" class="modal-close" id="btnCertificateSheetClose" aria-label="Close certificate" (click)="certificates.closeCertificateSheet()">
        <span class="icon icon-close" aria-hidden="true"></span>
      </button>
    </div>

    <div class="edit-sheet-body">
      <div class="revisions-view-tabs" id="certificateSheetTabs" role="tablist" aria-label="Certificate views" (keydown)="onTabKey($event)">
        @for (tab of tabs; track tab.id) {
          <button
            type="button"
            class="revisions-view-tab"
            role="tab"
            [class.cert-tab-raw]="tab.id === 'raw'"
            [attr.data-cert-tab]="tab.id"
            [class.active]="activeTab() === tab.id"
            [attr.aria-selected]="activeTab() === tab.id"
            [attr.aria-controls]="tab.panel"
            (click)="certificates.setActiveTab(tab.id)"
          >
            <span class="icon {{ tab.icon }}" aria-hidden="true"></span> {{ tab.label }}
          </button>
        }
      </div>

      @if (cert) {
        <div class="cert-tab-panel" id="certTabOverview" role="tabpanel" [hidden]="activeTab() !== 'overview'">
          @for (section of sections(); track section.title) {
            <div class="cert-section">
              <p class="cert-section-title">{{ section.title }}</p>
              @if (section.title === 'Validity' && validity(); as bar) {
                <div class="cert-validity-bar"><div class="cert-validity-fill {{ bar.tone }}" [style.width.%]="bar.percent"></div></div>
                <div class="cert-validity-legend"><span>{{ bar.from }}</span><span>{{ bar.to }}</span></div>
              }
              <table class="cert-field-table">
                @for (row of section.rows; track $index) {
                  <tr>
                    <th>{{ row.label }}</th>
                    <td>
                      @if (row.value === null || row.value === '') {
                        <span class="cert-absent">Not present</span>
                      } @else if (row.copy) {
                        <span
                          [class.cert-mono]="!!row.mono"
                          class="cert-copyable"
                          data-cert-action="copy-text"
                          title="Click to copy"
                          (click)="certificates.copyText(row.value, 'Value')"
                          >{{ row.value }}</span
                        >
                      } @else {
                        <span [class.cert-mono]="!!row.mono">{{ row.value }}</span>
                      }
                    </td>
                  </tr>
                }
              </table>
            </div>
          }
          @if (usedBy().length) {
            <div class="cert-section">
              <p class="cert-section-title">Used by</p>
              @for (s of usedBy(); track s.fieldName) {
                <button
                  type="button"
                  class="cert-usedby-row"
                  data-cert-action="show-field"
                  [attr.data-cert-signature-field]="s.fieldName"
                  (click)="signatures.showFieldOnDocument(s.fieldName)"
                >
                  <span class="icon icon-lock" aria-hidden="true"></span>
                  <span>{{ s.name || s.fieldName }}{{ s.page !== null ? ' — page ' + (s.page + 1) : '' }} &middot; field {{ s.fieldName }}</span>
                </button>
              }
            </div>
          }
        </div>

        <div class="cert-tab-panel" id="certTabExtensions" role="tabpanel" [hidden]="activeTab() !== 'extensions'">
          @if (extensions().rows.length) {
            @for (row of extensions().rows; track row.name) {
              <div class="cert-ext-row">
                <div class="cert-ext-head">
                  <span class="cert-ext-name">{{ row.name }}</span>
                  @if (row.critical) {
                    <span class="cert-ext-critical">CRITICAL</span>
                  }
                </div>
                <div class="cert-ext-value">{{ row.value }}</div>
              </div>
            }
            @if (extensions().revocationNote) {
              <p class="cert-check-why" style="margin-top: 12px">
                The CRL and OCSP addresses above are shown for reference only. pdf-seal makes no network requests and does not check whether this
                certificate has been revoked.
              </p>
            }
          } @else {
            <p class="cert-absent">This certificate carries no extensions we recognise. Extensions that are absent are not listed.</p>
          }
        </div>

        <div class="cert-tab-panel" id="certTabValidation" role="tabpanel" [hidden]="activeTab() !== 'validation'">
          @if (cert.checks.length) {
            <app-validation-list [checks]="cert.checks" />
          } @else {
            <p class="cert-absent">No checks were run on this certificate.</p>
          }
        </div>

        <div class="cert-tab-panel" id="certTabRaw" role="tabpanel" [hidden]="activeTab() !== 'raw'">
          <div class="cert-section">
            <p class="cert-section-title">PEM</p>
            <pre class="cert-raw-block">{{ cert.pem }}</pre>
          </div>
          <div class="cert-section">
            <p class="cert-section-title">DER</p>
            <p class="cert-check-why">{{ cert.derLength }} bytes, base64-encoded below.</p>
            <pre class="cert-raw-block">{{ cert.derBase64 }}</pre>
          </div>
        </div>
      }
    </div>

    <div class="edit-sheet-footer cert-sheet-footer">
      <button type="button" class="btn btn-ghost" data-cert-action="copy-pem" (click)="copyPem()">
        <span class="icon icon-copy" aria-hidden="true"></span> Copy PEM
      </button>
      <button type="button" class="btn btn-ghost" data-cert-action="export-pem" (click)="certificates.exportCertificate('pem')">
        <span class="icon icon-download" aria-hidden="true"></span> Export PEM
      </button>
      <button type="button" class="btn btn-ghost" data-cert-action="export-der" (click)="certificates.exportCertificate('der')">
        <span class="icon icon-download" aria-hidden="true"></span> Export DER
      </button>
      <button type="button" class="btn btn-ghost" data-cert-action="export-chain" id="btnExportChain" [hidden]="!inChain()" (click)="certificates.exportChain()">
        <span class="icon icon-layers" aria-hidden="true"></span> Export chain
      </button>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    id: 'certificateSheet',
    class: 'edit-sheet',
    tabindex: '-1',
    'aria-labelledby': 'certificateSheetTitle',
    '[class.is-open]': 'ui.sheets.certificate()',
    '[attr.aria-hidden]': '!ui.sheets.certificate()',
  },
})
export class CertificateSheet {
  protected readonly ui = inject(UiService);
  protected readonly certificates = inject(CertificatesStore);
  protected readonly signatures = inject(SignaturesStore);
  private readonly settings = inject(SettingsService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected readonly tabs = TABS;
  protected readonly displayName = certDisplayName;

  /** The Raw tab follows the raw-data setting -- don't strand the panel on it. */
  protected readonly activeTab = computed<CertificateTab>(() => {
    const tab = this.certificates.activeTab();
    return tab === 'raw' && !this.settings.effective().showRawPdfData ? 'overview' : tab;
  });
  protected readonly status = computed(() => {
    const cert = this.certificates.activeCert();
    return cert ? certStatusOf(cert) : 'unknown';
  });
  protected readonly roleLabel = computed(() => {
    const cert = this.certificates.activeCert();
    return cert ? (CERT_ROLE_LABEL[cert.role] ?? CERT_ROLE_LABEL.unknown) : '';
  });
  protected readonly sections = computed(() => {
    const cert = this.certificates.activeCert();
    return cert ? certOverviewSections(cert) : [];
  });
  protected readonly validity = computed(() => {
    const cert = this.certificates.activeCert();
    return cert ? certValidityBar(cert) : null;
  });
  protected readonly usedBy = computed(() => {
    const cert = this.certificates.activeCert();
    return cert ? certUsedBy(cert, this.certificates.report()) : [];
  });
  protected readonly extensions = computed(() => {
    const cert = this.certificates.activeCert();
    return cert ? certExtensionRows(cert) : { rows: [], revocationNote: false };
  });
  protected readonly inChain = computed(() => {
    const id = this.certificates.activeCertId();
    return !!id && !!this.certificates.chainContainingCert(id);
  });

  constructor() {
    effect(() => {
      const id = this.certificates.activeCertId();
      if (id && this.ui.sheets.certificate()) untracked(() => this.host.nativeElement.focus({ preventScroll: true }));
    });
  }

  protected copyPem(): void {
    const cert = this.certificates.activeCert();
    if (cert) void this.certificates.copyText(cert.pem, 'PEM');
  }

  /** Arrow keys move between the visible tabs. */
  protected onTabKey(event: KeyboardEvent): void {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const visible = TABS.filter((t) => t.id !== 'raw' || this.settings.effective().showRawPdfData);
    const current = visible.findIndex((t) => t.id === this.activeTab());
    if (current < 0) return;
    event.preventDefault();
    const next = visible[(current + (event.key === 'ArrowRight' ? 1 : visible.length - 1)) % visible.length];
    this.certificates.setActiveTab(next.id);
    (this.host.nativeElement.querySelector(`[data-cert-tab="${next.id}"]`) as HTMLElement | null)?.focus();
  }
}
