import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import type { CertificateChain, ParsedCertificate, ReportSignature, ValidationResult, ValidationStatus } from '../../core/models';
import { DocumentStore } from '../../core/document.store';
import { CertChain } from '../../shared/cert-chain';
import { CertDot } from '../../shared/cert-dot';
import { OvFacts } from '../../shared/ov-facts';
import { OvHero, type HeroModel } from '../../shared/ov-hero';
import { ValidationList } from '../../shared/validation-list';
import { CertSignatureCard } from './cert-signature-card';
import {
  CERT_OPERATIONS,
  CERT_STATUS_WORD,
  availableOperations,
  certDisplayName,
  certWorstStatus,
  checkMatchesFilterText,
  flatCertNodes,
  trustFacts,
  type CertificateOperation,
} from './certificates-model';
import { CertificatesStore } from './certificates.store';

const STATUS_ROWS: { status: ValidationStatus; label: (n: number) => string; detail: string }[] = [
  {
    status: 'fail',
    label: (n) => `${n} check${n === 1 ? '' : 's'} failed`,
    detail: 'Something here does not hold up. Checks marked “Not part of the verdict” do not change the badge.',
  },
  {
    status: 'warn',
    label: (n) => `${n} warning${n === 1 ? '' : 's'}`,
    detail: 'Worth reading before relying on this document. Checks marked “Not part of the verdict” do not change the badge.',
  },
  { status: 'pass', label: (n) => `${n} check${n === 1 ? '' : 's'} passed`, detail: 'Verified against what this file contains.' },
  { status: 'unknown', label: (n) => `${n} not checked`, detail: 'Includes trust and revocation, which pdf-seal never evaluates.' },
];

/**
 * Certificates: an optional standalone scratchpad and trust simulation, the
 * report summary with its check filters, each signature in full, other
 * certificates found in the file, and (opt-in) modification tools.
 */
@Component({
  selector: 'section[appCertificatesSection]',
  imports: [OvHero, OvFacts, CertDot, CertChain, ValidationList, CertSignatureCard],
  templateUrl: './certificates-section.html',
  styleUrl: './certificates-section.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    id: 'sectionCertificates',
    class: 'section-panel active section-panel-enter',
    'data-section-panel': 'certificates',
  },
})
export class CertificatesSection {
  protected readonly doc = inject(DocumentStore);
  protected readonly certificates = inject(CertificatesStore);

  protected readonly statusWord = CERT_STATUS_WORD;
  protected readonly operations = CERT_OPERATIONS;
  protected readonly name = certDisplayName;
  protected readonly scratchDragOver = signal(false);

  private readonly certById = (id: string) => this.certificates.certById(id);

  protected readonly report = this.certificates.reportForActiveFile;
  protected readonly signed = computed(() => !!this.report()?.documentHasSignatures);

  protected readonly state = computed<'empty' | 'loading' | 'error' | 'unsigned' | 'content'>(() => {
    if (!this.doc.activeFile()) return 'empty';
    if (this.certificates.loading() && !this.report()) return 'loading';
    if (this.certificates.error()) return 'error';
    const report = this.report();
    if (!report) return this.certificates.loading() ? 'loading' : 'empty';
    return report.documentHasSignatures ? 'content' : 'unsigned';
  });

  protected readonly unsignedHero = computed<HeroModel>(() => ({
    kind: 'certificates',
    icon: 'icon-shield',
    label: this.report()?.summary.headline ?? '',
    subtitle: 'No digital signatures in this file',
    badge: { type: 'pill', text: 'Not signed', tone: 'neutral' },
  }));

  protected readonly summaryHero = computed<HeroModel>(() => ({
    kind: 'certificates',
    icon: 'icon-shield',
    label: this.report()?.summary.headline ?? '',
    subtitle: 'Checked against what this file contains',
    badge: { type: 'cert', status: this.report()?.summary.status ?? 'unknown' },
  }));

  /** Kept beside the badge, never folded into it. */
  protected readonly summaryFacts = computed(() => {
    const report = this.report();
    if (!report) return [];
    return [
      { label: 'Certificates', value: '' + report.certificates.length },
      { label: 'Signatures', value: '' + report.signatures.length },
      ...trustFacts(report, this.certificates.trustResults()),
    ];
  });

  /** One expandable row per outcome that occurred, worst first, listing exactly the checks it counts. */
  protected readonly statusRows = computed(() => {
    const counts = this.report()?.summary.counts;
    if (!counts) return [];
    const statuses = this.certificates.filterStatuses();
    const text = this.certificates.filterText();
    const all = this.certificates.allChecks();
    return STATUS_ROWS.filter((r) => counts[r.status]).map((r) => ({
      status: r.status,
      count: counts[r.status],
      label: r.label(counts[r.status]),
      detail: r.detail,
      on: statuses.includes(r.status),
      checks: all.filter((c) => c.status === r.status && checkMatchesFilterText(c, text)),
    }));
  });

  protected readonly noFilterMatches = computed(() => !this.statusRows().some((r) => r.on && r.checks.length));

  protected readonly otherNodes = computed(() => {
    const report = this.report();
    if (!report) return [];
    const others = (report.unchainedCertificateIds || []).map(this.certById).filter((c): c is ParsedCertificate => !!c);
    return flatCertNodes(others, (cert) => `Issued by ${cert.issuer.commonName || cert.issuer.formatted || 'unknown'}`);
  });

  protected readonly scratchNodes = computed(() =>
    flatCertNodes(this.certificates.scratchpad()?.certificates ?? [], (cert) =>
      cert.selfIssued ? 'Self-issued' : `Issued by ${cert.issuer.commonName || cert.issuer.formatted || 'unknown'}`,
    ),
  );

  protected readonly trustResults = computed(() => {
    const report = this.report();
    const results = this.certificates.trustResults();
    if (!report || !results) return [];
    return report.chains.flatMap((chain) => {
      const sim = results[chain.id];
      if (!sim) return [];
      const leaf = this.certById(chain.certificateIds[0]);
      const label = chain.signatureFieldName ? `Signature: ${chain.signatureFieldName}` : leaf ? certDisplayName(leaf) : chain.id;
      return [{ chainId: chain.id, sim, label }];
    });
  });

  /** Signatures carrying a readable CMS, with which operations each supports. */
  protected readonly modifiable = computed(() =>
    (this.report()?.signatures ?? []).flatMap((sig) =>
      sig.cmsSlot && !sig.cmsError ? [{ sig, slot: sig.cmsSlot, ops: availableOperations(sig, this.certById) }] : [],
    ),
  );

  protected chainFor(sig: ReportSignature): CertificateChain | null {
    return this.report()?.chains.find((c) => c.id === sig.chainId) ?? null;
  }

  protected worst(checks: ValidationResult[]): ValidationStatus {
    return certWorstStatus(checks.map((c) => c.status));
  }

  protected openModify(op: CertificateOperation, fieldName: string): void {
    this.certificates.openModifySheet(op, fieldName);
  }

  protected onScratchFile(input: HTMLInputElement): void {
    const file = input.files?.[0] ?? null;
    input.value = '';
    if (file) this.certificates.setScratchpadFile(file);
  }

  protected onScratchDragOver(event: DragEvent): void {
    event.preventDefault();
    this.scratchDragOver.set(true);
  }

  protected onScratchDrop(event: DragEvent): void {
    event.preventDefault();
    this.scratchDragOver.set(false);
    const file = event.dataTransfer?.files?.[0];
    if (file) this.certificates.setScratchpadFile(file);
  }

  protected onTrustFile(input: HTMLInputElement): void {
    const file = input.files?.[0] ?? null;
    input.value = '';
    if (file) void this.certificates.runTrustSimulation(file);
  }
}
