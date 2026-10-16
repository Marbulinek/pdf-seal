import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, untracked } from '@angular/core';
import type { ParsedCertificate } from '../../core/models';
import { UiService } from '../../core/ui.service';
import { CERT_OPERATIONS, CERT_ROLE_LABEL, certDisplayName, intermediatesOf } from '../../features/certificates/certificates-model';
import { CertificatesStore } from '../../features/certificates/certificates.store';
import { CertCompareCard } from './cert-compare-card';

/**
 * Rewrites the certificates inside a signature, for building test documents.
 * A three-step review because it changes the file: what will change, what it
 * changes to, and what that costs.
 */
@Component({
  selector: 'aside[appCertificateModifySheet]',
  imports: [CertCompareCard],
  templateUrl: './certificate-modify-sheet.html',
  styleUrl: './certificate-modify-sheet.css',
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
