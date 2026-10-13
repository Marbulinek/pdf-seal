import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, input, untracked } from '@angular/core';
import type { ParsedCertificate } from '../../core/models';
import { UiService } from '../../core/ui.service';
import { certFormatDate } from '../../core/util/format';
import {
  CERT_OPERATIONS,
  CERT_ROLE_LABEL,
  certDisplayName,
  intermediatesOf,
  validityTimeline,
} from '../../features/certificates/certificates-model';
import { CertificatesStore } from '../../features/certificates/certificates.store';
import { ValidityTimeline } from '../../shared/validity-timeline';

/** A compact card for one side of the before/after pair. */
@Component({
  selector: 'app-cert-compare-card',
  template: `
    @if (cert(); as c) {
      <div class="cert-compare-card">
        <span class="cert-compare-label">{{ label() }}</span>
        <span class="cert-compare-name">{{ name(c) }}</span>
        <span class="cert-compare-meta">Issued by {{ c.issuer.commonName || c.issuer.formatted || 'unknown' }}</span>
        <span class="cert-compare-meta">{{ date(c.validFrom) }} – {{ date(c.validTo) }}</span>
      </div>
    } @else {
      <div class="cert-compare-card is-empty"><span class="cert-compare-label">{{ label() }}</span><span class="cert-absent">Nothing selected yet</span></div>
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: 'display: contents' },
})
export class CertCompareCard {
  readonly cert = input<ParsedCertificate | null>(null);
  readonly label = input.required<string>();
  protected readonly name = certDisplayName;
  protected date(value: string): string {
    return certFormatDate(value) || '?';
  }
}

/**
 * Rewrites the certificates inside a signature, for building test documents.
 * A three-step review because it changes the file: what will change, what it
 * changes to, and what that costs.
 */
@Component({
  selector: 'aside[appCertificateModifySheet]',
  imports: [CertCompareCard],
  template: `
    @let state = certificates.modify();
    <div class="edit-sheet-header">
      <span class="edit-sheet-grabber" aria-hidden="true"></span>
      <span class="panel-dot dot-coral"></span>
      <h3 id="certificateModifySheetTitle">Modify certificates</h3>
      <span class="edit-sheet-subject" id="certificateModifySheetSubject">{{ spec()?.label }}</span>
      <button type="button" class="modal-close" id="btnCertificateModifySheetClose" aria-label="Close" (click)="certificates.closeModifySheet()">
        <span class="icon icon-close" aria-hidden="true"></span>
      </button>
    </div>

    <div class="edit-sheet-body" id="certificateModifyBody">
      @if (state && spec(); as spec) {
        <div class="cert-section">
          <p class="cert-section-title">{{ spec.label }}</p>
          <p class="cert-check-why">{{ spec.blurb }} This affects the signature in field <strong>{{ state.fieldName }}</strong>.</p>
        </div>

        <div class="cert-section">
          @switch (state.op) {
            @case ('remove-certificate') {
              <p class="cert-section-title">Which certificate</p>
              <div class="cert-modify-choices">
                @for (c of own(); track c.id) {
                  <label class="cert-modify-choice" [class.is-selected]="state.targetFingerprint === c.id">
                    <input type="radio" name="certRemoveTarget" [value]="c.id" [checked]="state.targetFingerprint === c.id" (change)="certificates.setModifyTarget(c.id)" />
                    <span>
                      <strong>{{ name(c) }}</strong>
                      <span class="cert-compare-meta">{{ role(c) }}{{ c.id === signature()?.signerCertificateId ? ' — this is the signer' : '' }}</span>
                    </span>
                  </label>
                }
              </div>
            }
            @case ('remove-intermediates') {
              <p class="cert-section-title">What will be removed</p>
              <div class="cert-modify-choices">
                @for (c of intermediates(); track c.id) {
                  <div class="cert-modify-choice is-static">
                    <span><strong>{{ name(c) }}</strong><span class="cert-compare-meta">Intermediate CA</span></span>
                  </div>
                }
              </div>
            }
            @default {
              <p class="cert-section-title">Replacement</p>
              <button type="button" class="btn btn-primary btn-block" id="btnPickCertificateFile" (click)="fileInput.click()">
                <span class="icon icon-upload-device" aria-hidden="true"></span>
                {{ state.file ? state.file.name : spec.multiFile ? 'Choose certificate file (.pem with one or more)…' : 'Choose certificate file…' }}
              </button>
              @if (state.error) {
                <div class="cert-modify-error">{{ state.error }}</div>
              }
              @if (state.parsed; as parsed) {
                <div class="cert-compare">
                  @if (state.op === 'replace-signer') {
                    <app-cert-compare-card [cert]="signer()" label="Current" />
                  } @else {
                    <div class="cert-compare-card">
                      <span class="cert-compare-label">Current</span>
                      @for (c of aboveSigner(); track c.id) {
                        <span class="cert-compare-name">{{ name(c) }}</span>
                      } @empty {
                        <span class="cert-absent">None</span>
                      }
                    </div>
                  }
                  <span class="cert-compare-arrow" aria-hidden="true">→</span>
                  @if (state.op === 'replace-signer') {
                    <app-cert-compare-card [cert]="parsed[0] ?? null" label="Replacement" />
                  } @else {
                    <div class="cert-compare-card">
                      <span class="cert-compare-label">Replacement</span>
                      @for (c of parsed; track $index) {
                        <span class="cert-compare-name">{{ name(c) }}</span>
                      }
                    </div>
                  }
                </div>
              }
            }
          }
        </div>

        <div class="cert-section">
          <div class="cert-danger-block" [class.is-breaking]="breaks()" [class.is-preserving]="!breaks()">
            <span class="icon {{ breaks() ? 'icon-alert-triangle' : 'icon-info-circle' }}" aria-hidden="true"></span>
            <div>
              @if (breaks()) {
                <strong>This will break the signature.</strong> The public key it is checked against will no longer be the key that made it, so the
                signature will stop verifying. The document’s own content is untouched, so it will still report as unchanged.
              } @else {
                <strong>This will not break the signature.</strong> The certificates inside a signature are not covered by the signature itself, so it
                will still verify — only the chain around it changes.
              }
              <div class="cert-modify-note">Your loaded document is replaced by the modified copy. The original file on disk is never touched.</div>
            </div>
          </div>
        </div>
      }
    </div>

    <div class="edit-sheet-footer cert-modify-footer">
      <button type="button" class="btn btn-ghost" id="btnCertificateModifyCancel" (click)="certificates.closeModifySheet()">Cancel</button>
      <button
        type="button"
        class="btn btn-danger"
        id="btnCertificateModifyApply"
        [disabled]="!ready() || certificates.modifyApplying()"
        (click)="certificates.confirmModification()"
      >
        Apply change
      </button>
    </div>
    <input
      #fileInput
      type="file"
      id="certificateFileInput"
      accept=".cer,.crt,.der,.pem,.p7b,application/x-x509-ca-cert,application/x-pem-file"
      hidden
      (change)="onFile(fileInput)"
    />
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    id: 'certificateModifySheet',
    class: 'edit-sheet',
    tabindex: '-1',
    'aria-labelledby': 'certificateModifySheetTitle',
    '[class.is-open]': 'ui.sheets.certificateModify()',
    '[attr.aria-hidden]': '!ui.sheets.certificateModify()',
  },
})
export class CertificateModifySheet {
  protected readonly ui = inject(UiService);
  protected readonly certificates = inject(CertificatesStore);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected readonly name = certDisplayName;

  protected readonly spec = computed(() => {
    const op = this.certificates.modify()?.op;
    return op ? CERT_OPERATIONS[op] : null;
  });
  protected readonly signature = computed(() => {
    const field = this.certificates.modify()?.fieldName;
    return this.certificates.report()?.signatures.find((s) => s.fieldName === field) ?? null;
  });
  protected readonly own = computed(() =>
    (this.signature()?.certificateIds || []).map((id) => this.certificates.certById(id)).filter((c): c is ParsedCertificate => !!c),
  );
  protected readonly signer = computed(() => this.certificates.certById(this.signature()?.signerCertificateId));
  protected readonly intermediates = computed(() => {
    const sig = this.signature();
    return sig ? intermediatesOf(sig, this.own()) : [];
  });
  protected readonly aboveSigner = computed(() => this.own().filter((c) => c.id !== this.signature()?.signerCertificateId));
  protected readonly ready = computed(() => {
    const state = this.certificates.modify();
    if (!state) return false;
    if (state.op === 'remove-certificate') return !!state.targetFingerprint;
    if (state.op === 'remove-intermediates') return this.intermediates().length > 0;
    return !!state.parsed?.length;
  });
  /** Not uniform: only replacing the signer (or removing it) breaks the signature. */
  protected readonly breaks = computed(() => {
    const state = this.certificates.modify();
    if (!state) return false;
    return (
      state.op === 'replace-signer' ||
      (state.op === 'remove-certificate' && state.targetFingerprint === this.signature()?.signerCertificateId)
    );
  });

  constructor() {
    effect(() => {
      const open = this.ui.sheets.certificateModify();
      if (open && this.certificates.modify()) untracked(() => this.host.nativeElement.focus({ preventScroll: true }));
    });
  }

  protected role(cert: ParsedCertificate): string {
    return CERT_ROLE_LABEL[cert.role] ?? CERT_ROLE_LABEL.unknown;
  }

  protected onFile(input: HTMLInputElement): void {
    const file = input.files?.[0];
    // Reset so picking the same file twice still fires a change.
    input.value = '';
    if (file) void this.certificates.pickModifyFile(file);
  }
}

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
