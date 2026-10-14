import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import type { CertificateChain, ParsedCertificate, ReportSignature, ValidationResult, ValidationStatus } from '../../core/models';
import { DocumentStore } from '../../core/document.store';
import { isRectPracticallyInvisible } from '../../core/field-rules';
import { certFormatDate, ovInitials } from '../../core/util/format';
import { CertByteMap, CertChain } from '../../shared/cert-chain';
import { CertDot, Evidence, OvFacts, OvHero, type HeroModel } from '../../shared/ov-ui';
import { CheckCounts, ValidationList } from '../../shared/validation-list';
import { ValidityTimeline } from '../../shared/validity-timeline';
import { OverviewStore } from '../overview/overview.store';
import {
  CERT_OPERATIONS,
  CERT_STATUS_WORD,
  availableOperations,
  byteMapOf,
  certDisplayName,
  certWorstStatus,
  chainNodes,
  checkMatchesFilterText,
  flatCertNodes,
  signatureEvidenceRows,
  validityTimeline,
  type CertificateOperation,
} from './certificates-model';
import { CertificatesStore } from './certificates.store';

const STATUS_ROWS: { status: ValidationStatus; label: (n: number) => string; detail: string }[] = [
  { status: 'fail', label: (n) => `${n} check${n === 1 ? '' : 's'} failed`, detail: 'Something here does not hold up.' },
  { status: 'warn', label: (n) => `${n} warning${n === 1 ? '' : 's'}`, detail: 'Worth reading before relying on this document.' },
  { status: 'pass', label: (n) => `${n} check${n === 1 ? '' : 's'} passed`, detail: 'Verified against what this file contains.' },
  { status: 'unknown', label: (n) => `${n} not checked`, detail: 'Includes trust and revocation, which pdf-seal never evaluates.' },
];

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
  protected readonly evidence = computed(() => signatureEvidenceRows(this.sig()));
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

/**
 * Certificates: an optional standalone scratchpad and trust simulation, the
 * report summary with its check filters, each signature in full, other
 * certificates found in the file, and (opt-in) modification tools.
 */
@Component({
  selector: 'section[appCertificatesSection]',
  imports: [OvHero, OvFacts, CertDot, CertChain, ValidationList, CertSignatureCard],
  template: `
    <!-- Works with no document loaded: a general-purpose certificate inspector. -->
    <section class="panel certificates-scratchpad-panel" id="certificatesScratchpadPanel">
      <h3><span class="panel-dot dot-ocean"></span>Certificate scratchpad</h3>
      <p class="cert-hint">
        Paste or drop a certificate (PEM, DER, or a .p7b bundle) to inspect it on its own — no document required. Paste two to also check whether one
        issues the other.
      </p>

      <div
        class="cert-scratchpad-dropzone"
        id="certScratchpadDropzone"
        [class.is-dragover]="scratchDragOver()"
        (dragover)="onScratchDragOver($event)"
        (dragleave)="scratchDragOver.set(false)"
        (drop)="onScratchDrop($event)"
      >
        <textarea
          #scratchText
          id="certScratchpadInput"
          class="cert-scratchpad-textarea"
          placeholder="-----BEGIN CERTIFICATE-----&#10;…&#10;-----END CERTIFICATE-----"
          spellcheck="false"
          [value]="certificates.scratchpadText()"
          (input)="certificates.setScratchpadText(scratchText.value)"
        ></textarea>
        <div class="cert-scratchpad-actions">
          <button type="button" class="btn btn-ghost btn-sm" id="btnCertScratchpadPick" (click)="scratchFile.click()">
            <span class="icon icon-upload-device" aria-hidden="true"></span> Choose file…
          </button>
          <span class="cert-scratchpad-filename" id="certScratchpadFilename">{{ certificates.scratchpadFile()?.name ?? '' }}</span>
          <button type="button" class="btn btn-primary btn-sm" id="btnCertScratchpadInspect" (click)="certificates.inspectScratchpad()">Inspect</button>
          <button type="button" class="btn btn-ghost btn-sm" id="btnCertScratchpadClear" [hidden]="!certificates.scratchpad()" (click)="certificates.clearScratchpad()">
            Clear
          </button>
        </div>
        <input
          #scratchFile
          type="file"
          id="certScratchpadFileInput"
          accept=".cer,.crt,.der,.pem,.p7b,application/x-x509-ca-cert,application/x-pem-file"
          hidden
          (change)="onScratchFile(scratchFile)"
        />
      </div>

      <div class="panel-loading" id="certScratchpadLoading" [hidden]="!certificates.scratchpadLoading()">
        <span class="spinner" aria-hidden="true"></span> Reading certificate…
      </div>
      <div class="cert-empty cert-empty-error" id="certScratchpadError" [hidden]="!certificates.scratchpadError()">
        <p>{{ certificates.scratchpadError() }}</p>
      </div>
      <div id="certScratchpadResult">
        @if (certificates.scratchpad(); as pad) {
          <app-cert-chain [nodes]="scratchNodes()" [flat]="true" [selectedId]="certificates.activeCertId()" (openCert)="certificates.openCertificateSheet($event)" />
          @if (pad.chain && pad.chain.certificateIds.length > 1) {
            <p class="cert-section-title" style="margin-top: 12px">Chain checks</p>
            <app-validation-list [checks]="pad.chain.checks" />
          }
          @if (pad.links && pad.links.length === 2 && pad.certificates.length === 2) {
            <p class="cert-section-title" style="margin-top: 12px">Does one issue the other?</p>
            @for (link of pad.links; track $index) {
              <details class="cert-details-block">
                <summary class="cert-details-summary">
                  <span class="cert-details-summary-main">
                    <span class="icon icon-chevron-right cert-details-caret" aria-hidden="true"></span>
                    <app-cert-dot [status]="worst(link.checks)" />
                    <span class="cert-status-label"
                      >Does “{{ name(pad.certificates[link.subjectIndex]) }}” name “{{ name(pad.certificates[link.issuerIndex]) }}” as its issuer, and does
                      that hold up?</span
                    >
                  </span>
                </summary>
                <div class="cert-details-body"><app-validation-list [checks]="link.checks" /></div>
              </details>
            }
          }
        }
      </div>
    </section>

    <section class="panel certificates-trustsim-panel" id="certificatesTrustSimPanel" [hidden]="!signed()">
      <h3><span class="panel-dot dot-coral"></span>Trust simulation <span class="cert-simulated-badge">Simulated</span></h3>
      <p class="cert-hint">
        <span id="certTrustSimNote"></span> This is opt-in and answers a different question:
        <em>given a root bundle you supply, would this chain be trusted?</em> The result below is a simulation against your bundle only, kept separate
        from the real report, and never changes it.
      </p>
      <div class="cert-scratchpad-actions">
        <button type="button" class="btn btn-ghost btn-sm" id="btnTrustSimPick" (click)="trustFile.click()">
          <span class="icon icon-upload-device" aria-hidden="true"></span> Upload root bundle (PEM)…
        </button>
        <span class="cert-scratchpad-filename" id="certTrustSimFilename">{{ certificates.trustFileName() }}</span>
        <input
          #trustFile
          type="file"
          id="certTrustSimFileInput"
          accept=".pem,.cer,.crt,.der,application/x-pem-file,application/x-x509-ca-cert"
          hidden
          (change)="onTrustFile(trustFile)"
        />
      </div>
      <div class="panel-loading" id="certTrustSimLoading" [hidden]="!certificates.trustLoading()">
        <span class="spinner" aria-hidden="true"></span> Simulating…
      </div>
      <div class="cert-empty cert-empty-error" id="certTrustSimError" [hidden]="!certificates.trustError()">
        <p>{{ certificates.trustError() }}</p>
      </div>
      <div id="certTrustSimResults">
        @for (r of trustResults(); track r.chainId) {
          <div class="cert-trustsim-card is-{{ r.sim.status }}">
            <div class="cert-trustsim-head">
              <span class="cert-simulated-badge">Simulated</span>
              <span class="cert-badge is-{{ r.sim.status }}">{{ r.sim.status === 'pass' ? '✓' : '✕' }} {{ statusWord[r.sim.status] }}</span>
              <strong>{{ r.label }}</strong>
            </div>
            <p class="cert-trustsim-detail">{{ r.sim.detail }}</p>
            <p class="cert-check-why">Revocation: not checked — unaffected by this simulation. pdf-seal makes no network requests, with or without a bundle.</p>
          </div>
        }
      </div>
    </section>

    <section class="panel certificates-summary-panel" id="certificatesSummaryPanel">
      <div class="panel-overlay" id="certificatesPanelOverlay" [class.is-hidden]="!!doc.pdfDoc()">
        <div class="panel-overlay-text">Upload a document first to inspect its certificates</div>
      </div>
      <h3><span class="panel-dot dot-ocean"></span>Certificates</h3>
      <p class="cert-hint">
        The certificates behind this document's digital signatures — who signed it, which authority issued that identity, and what can actually be
        proven from the file itself.
      </p>

      <!-- Always visible, never dismissible: the whole point is not overstating what was checked. -->
      <div class="cert-trust-banner" id="certTrustBanner" [hidden]="state() !== 'content'">
        <span class="icon icon-alert-triangle" aria-hidden="true"></span>
        <div class="cert-trust-banner-text" id="certTrustBannerText">{{ report()?.trust?.note }}</div>
      </div>

      <div class="cert-empty" id="certificatesEmptyState" [hidden]="state() !== 'empty' && state() !== 'unsigned'">
        @if (state() === 'unsigned' && report(); as r) {
          <app-ov-hero [hero]="unsignedHero()" />
          <p>
            pdf-seal prepares signature fields; it does not sign documents itself. Certificates appear here once the document has been signed somewhere
            else and loaded back in.
          </p>
          @if (r.unsignedSignatureFieldNames.length) {
            <p><strong>Waiting to be signed:</strong> {{ r.unsignedSignatureFieldNames.join(', ') }} — place and edit these in the Signatures section.</p>
          }
          @for (w of r.warnings; track $index) {
            <p>{{ w }}</p>
          }
        } @else {
          <p>Upload a document to see the certificates it carries.</p>
        }
      </div>
      <div class="panel-loading" id="certificatesLoadingState" [hidden]="state() !== 'loading'">
        <span class="spinner" aria-hidden="true"></span> Reading certificates…
      </div>
      <div class="cert-empty cert-empty-error" id="certificatesErrorState" [hidden]="state() !== 'error'">
        <p>{{ certificates.error() }}</p>
      </div>
      <div class="cert-summary" id="certificatesSummary" [hidden]="state() !== 'content'">
        @if (state() === 'content' && report(); as r) {
          <div class="overview-header">
            <app-ov-hero [hero]="summaryHero()" />
            <app-ov-facts
              [facts]="[
                { label: 'Certificates', value: '' + r.certificates.length },
                { label: 'Signatures', value: '' + r.signatures.length },
              ]"
            />
          </div>
          @if (statusRows().length) {
            <div class="cert-toolbar">
              <div class="cert-filter-chips">
                @for (row of statusRows(); track row.status) {
                  <button
                    type="button"
                    class="cert-filter-chip is-{{ row.status }}"
                    [class.is-active]="row.on"
                    data-cert-action="toggle-cert-filter-status"
                    [attr.data-status]="row.status"
                    [attr.aria-pressed]="row.on"
                    (click)="certificates.toggleFilterStatus(row.status)"
                  >
                    <app-cert-dot [status]="row.status" /> {{ statusWord[row.status] }} <span class="cert-filter-chip-count">{{ row.count }}</span>
                  </button>
                }
              </div>
              <input
                #filterSearch
                type="search"
                class="cert-filter-search"
                id="certFilterSearchInput"
                placeholder="Filter by check id or text…"
                aria-label="Filter checks"
                [value]="certificates.filterText()"
                (input)="certificates.setFilterText(filterSearch.value)"
              />
              <div class="cert-toolbar-copy">
                <button type="button" class="icon-btn" data-cert-action="copy-cert-summary" title="Copy summary" aria-label="Copy summary" (click)="certificates.copySummary()">
                  <span class="icon icon-copy" aria-hidden="true"></span>
                </button>
                <button type="button" class="icon-btn" data-cert-action="copy-cert-json" title="Copy JSON" aria-label="Copy JSON" (click)="certificates.copyJson()">
                  <span class="icon icon-code" aria-hidden="true"></span>
                </button>
              </div>
            </div>
            @if (certificates.filterActive()) {
              <p class="cert-toolbar-caption">
                Showing {{ certificates.shownCheckCount() }} of {{ certificates.allChecks().length }} check{{ certificates.allChecks().length === 1 ? '' : 's' }}
                <button type="button" class="cert-toolbar-caption-clear" data-cert-action="clear-cert-filter" (click)="certificates.clearFilter()">Clear filter</button>
              </p>
            }
          }
          <div class="cert-status-list">
            @for (row of statusRows(); track row.status; let i = $index) {
              @if (row.on && row.checks.length) {
                <details class="cert-details-block cert-status-block is-{{ row.status }}" [style.--i]="i" [open]="certificates.filterActive()">
                  <summary class="cert-details-summary">
                    <span class="cert-details-summary-main">
                      <span class="icon icon-chevron-right cert-details-caret" aria-hidden="true"></span>
                      <app-cert-dot [status]="row.status" />
                      <span class="cert-status-label">{{ row.label }}{{ certificates.filterActive() ? ' — ' + row.checks.length + ' shown' : '' }}</span>
                    </span>
                  </summary>
                  <div class="cert-details-body">
                    <p class="cert-status-caption">{{ row.detail }}</p>
                    <app-validation-list [checks]="row.checks" [showSource]="true" (openCert)="certificates.openCertificateSheet($event, 'validation')" />
                  </div>
                </details>
              }
            }
            @if (certificates.filterActive() && noFilterMatches()) {
              <p class="cert-status-caption">No checks match this filter.</p>
            }
          </div>
          @if (r.warnings.length) {
            <p class="cert-section-title" style="margin-top: 14px">Reading this file</p>
            <div class="cert-status-list">
              @for (w of r.warnings; track $index; let i = $index) {
                <div class="cert-status-row is-warn" [style.--i]="i">
                  <app-cert-dot status="warn" />
                  <div><span class="cert-status-detail">{{ w }}</span></div>
                </div>
              }
            </div>
          }
        }
      </div>
    </section>

    <section class="panel certificates-signatures-panel" id="certificatesSignaturesPanel" [hidden]="state() !== 'content' || !report()?.signatures?.length">
      <h3><span class="panel-dot dot-coral"></span>Signatures</h3>
      <p class="cert-hint">Each signature, the certificate that made it, and the chain behind that certificate.</p>
      <div class="cert-signature-list" id="certSignatureList">
        @if (state() === 'content' && report(); as r) {
          @for (sig of r.signatures; track sig.fieldName; let i = $index) {
            <details appCertSignatureCard [sig]="sig" [chain]="chainFor(sig)" [index]="i"></details>
          }
        }
      </div>
    </section>

    <section class="panel certificates-other-panel" id="certificatesOtherPanel" [hidden]="state() !== 'content' || !otherNodes().length">
      <h3><span class="panel-dot dot-ocean"></span>Other certificates</h3>
      <p class="cert-hint">Present in the file but not reached by any signature — usually long-term validation material carried in the document security store.</p>
      <div class="cert-card-list" id="certOtherList">
        <app-cert-chain [nodes]="otherNodes()" [flat]="true" [selectedId]="certificates.activeCertId()" (openCert)="certificates.openCertificateSheet($event)" />
      </div>
    </section>

    <!-- Set apart from the report above: this rewrites the document. -->
    <section class="panel certificates-modify-panel" id="certificatesModifyPanel" [hidden]="state() !== 'content' || !modifiable().length">
      <h3><span class="panel-dot dot-coral"></span>Modify</h3>
      <p class="cert-hint">
        Tools for building test documents: change the certificates embedded in a signature to see how a verifier reacts. The file you downloaded is a
        copy — the document loaded here is only replaced once you apply a change.
      </p>
      <div class="cert-modify-list" id="certModifyList">
        @for (m of modifiable(); track m.sig.fieldName) {
          <div class="cert-modify-group">
            <div class="cert-modify-head">
              <span class="icon icon-lock" aria-hidden="true"></span>
              <span class="cert-modify-title">Field {{ m.sig.fieldName }}</span>
            </div>
            <p class="cert-modify-room">
              Signature slot holds {{ m.slot.capacityBytes }} bytes; it currently uses {{ m.slot.derLength }} — <strong>{{ m.slot.headroomBytes }} spare</strong>. A
              change that needs more than that cannot be applied to this document.
            </p>
            <div class="cert-modify-actions">
              @for (o of m.ops; track o.op) {
                <button
                  type="button"
                  class="btn btn-ghost cert-modify-btn"
                  data-cert-action="modify"
                  [attr.data-cert-op]="o.op"
                  [attr.data-cert-modify-field]="m.sig.fieldName"
                  [disabled]="!o.available"
                  [attr.title]="o.available ? null : o.reason"
                  (click)="openModify(o.op, m.sig.fieldName)"
                >
                  {{ operations[o.op].label }}
                </button>
              }
            </div>
          </div>
        }
      </div>
    </section>
  `,
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
