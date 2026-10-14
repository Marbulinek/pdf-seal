import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, untracked, viewChildren } from '@angular/core';
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
  templateUrl: './certificate-sheet.html',
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
  private readonly tabButtons = viewChildren<ElementRef<HTMLButtonElement>>('tabButton');

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
    this.tabButtons().find((b) => b.nativeElement.dataset['certTab'] === next.id)?.nativeElement.focus();
  }
}
