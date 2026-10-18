import { ChangeDetectionStrategy, Component, computed, effect, inject, input, untracked } from '@angular/core';
import type { CertificateChain, ParsedCertificate, ReportSignature, ValidationResult } from '../../core/models';
import { DocumentStore } from '../../core/document.store';
import { isRectPracticallyInvisible } from '../../core/field-rules';
import { certFormatDate, ovInitials } from '../../core/util/format';
import { CertByteMap } from '../../shared/cert-byte-map';
import { CertChain } from '../../shared/cert-chain';
import { CheckCounts } from '../../shared/check-counts';
import { Evidence } from '../../shared/evidence';
import { OvHero, type HeroModel } from '../../shared/ov-hero';
import { ValidationList } from '../../shared/validation-list';
import { ValidityTimeline } from '../../shared/validity-timeline';
import { OverviewStore } from '../overview/overview.store';
import { byteMapOf, chainNodes, signatureEvidenceRows, validityTimeline } from './certificates-model';
import { CertificatesStore } from './certificates.store';

/** One signature: who, evidence, byte coverage, chain, validity timeline and every check. */
@Component({
  selector: 'details[appCertSignatureCard]',
  imports: [OvHero, Evidence, CertByteMap, CertChain, ValidityTimeline, CheckCounts, ValidationList],
  template: `
    @let s = sig();
    <summary class="cert-signature-summary">
      <app-ov-hero [hero]="hero()" />
      @if (invisible()) {
        <span class="cert-invisible-badge" title="This field's /Rect is at or near zero size, so it has no visible footprint on the page."
          ><span class="icon icon-eye-off" aria-hidden="true"></span> Invisible field</span
        >
      }
    </summary>
    @if (invisible()) {
      <button
        type="button"
        class="btn btn-ghost btn-small cert-locate-btn"
        data-cert-action="show-field"
        [attr.data-cert-signature-field]="s.fieldName"
        (click)="certificates.flashSignatureField(s.fieldName)"
      >
        <span class="icon icon-eye-off" aria-hidden="true"></span> Locate on page
      </button>
    }
    <div class="cert-evidence">
      <p class="cert-section-title">Signature evidence</p>
      <app-evidence [rows]="evidence()" [nativeChain]="overview.nativeChain()" (compare)="overview.openVersionsDiff($event.from, $event.to, 'overview', null)" />
    </div>
    @if (byteMap(); as map) {
      <app-cert-bytemap [map]="map" />
    }
    <app-cert-chain
      [nodes]="nodes()"
      [selectedId]="certificates.activeCertId()"
      (openCert)="certificates.openCertificateSheet($event)"
      (showField)="certificates.flashSignatureField($event)"
    />
    @if (timeline(); as t) {
      <app-validity-timeline [timeline]="t" [fieldName]="s.fieldName" (expand)="certificates.openTimelineSheet(s.fieldName)" />
    }
    <details class="cert-details-block">
      <summary class="cert-details-summary">
        <span class="cert-details-summary-main">
          <span class="icon icon-chevron-right cert-details-caret" aria-hidden="true"></span>
          <span class="cert-details-summary-label">What was checked</span>
          <span class="cert-details-summary-total">{{ allChecks().length }}</span>
        </span>
        <span class="cert-details-summary-counts"><app-check-counts [checks]="allChecks()" /></span>
      </summary>
      <div class="cert-details-body">
        <app-validation-list [checks]="s.checks" />
        @if (chainChecks().length) {
          <p class="cert-section-title" style="margin-top: 12px">Chain</p>
          <app-validation-list [checks]="chainChecks()" />
        }
        @if (certChecks().length) {
          <p class="cert-section-title" style="margin-top: 12px">Certificates</p>
          <app-validation-list [checks]="certChecks()" />
        }
      </div>
    </details>
  `,
  styleUrl: './cert-signature-card.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'cert-signature-card',
    '[attr.data-cert-signature-card]': 'sig().fieldName',
    '[style.--i]': 'index()',
    '[open]': 'certificates.openCards().includes(sig().fieldName)',
    '(toggle)': 'onToggle($event)',
  },
})
export class CertSignatureCard {
  readonly sig = input.required<ReportSignature>();
  readonly chain = input<CertificateChain | null>(null);
  readonly index = input(0);
  protected readonly certificates = inject(CertificatesStore);
  protected readonly overview = inject(OverviewStore);
  private readonly doc = inject(DocumentStore);

  private readonly certById = (id: string) => this.certificates.certById(id);

  protected readonly hero = computed<HeroModel>(() => {
    const sig = this.sig();
    const meta: string[] = [];
    if (sig.page !== null && sig.page !== undefined) meta.push(`Page ${sig.page + 1}`);
    meta.push(`Field: ${sig.fieldName}`);
    if (sig.reason) meta.push(sig.reason);
    const signedAt = certFormatDate(sig.signedAttributes?.signingTime || sig.signingTimeClaimed);
    if (signedAt) meta.push(`Claimed ${signedAt}`);
    return {
      kind: 'signature',
      icon: 'icon-pen',
      avatar: sig.name ? ovInitials(sig.name) : null,
      label: sig.name ? `Signature ${this.index() + 1} · ${sig.name}` : `Signature ${this.index() + 1}`,
      subtitle: meta.join(' · '),
      badge: { type: 'cert', status: sig.status },
    };
  });
  /** The field itself lives in the document's fields: flag a near-zero /Rect. */
  protected readonly invisible = computed(() => {
    const field = this.doc.fields().find((f) => f.name === this.sig().fieldName);
    return !!field && isRectPracticallyInvisible(field.rect);
  });
  protected readonly evidence = computed(() => {
    const chainId = this.chain()?.id;
    return signatureEvidenceRows(this.sig(), (chainId && this.certificates.trustResults()?.[chainId]) || null);
  });
  protected readonly byteMap = computed(() => byteMapOf(this.sig()));
  protected readonly nodes = computed(() => chainNodes(this.chain(), this.sig(), this.certById));
  protected readonly timeline = computed(() => validityTimeline(this.chain(), this.sig(), this.certById));
  protected readonly chainChecks = computed<ValidationResult[]>(() => {
    const chain = this.chain();
    return chain ? [...chain.checks, ...chain.links.flatMap((l) => l.checks)] : [];
  });
  protected readonly certChecks = computed<ValidationResult[]>(() => {
    const chain = this.chain();
    return chain
      ? chain.certificateIds
          .map(this.certById)
          .filter((c): c is ParsedCertificate => !!c)
          .flatMap((c) => c.checks)
      : [];
  });
  protected readonly allChecks = computed(() => [...this.sig().checks, ...this.chainChecks(), ...this.certChecks()]);

  constructor() {
    // "Show changes after signing" appears only for this file's native chain.
    effect(() => {
      const rows = this.evidence();
      untracked(() => rows.forEach((r) => r.slot && this.overview.checkNativeChain(r.slot.to)));
    });
  }

  protected onToggle(event: Event): void {
    const open = (event.target as HTMLDetailsElement).open;
    if (event.target !== event.currentTarget) return; // a nested <details> toggled
    if (open !== this.certificates.openCards().includes(this.sig().fieldName)) this.certificates.setCardOpen(this.sig().fieldName, open);
  }
}
