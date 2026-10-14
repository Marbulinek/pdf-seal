import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import type { ParsedCertificate } from '../../core/models';
import { certFormatDate } from '../../core/util/format';
import { certDisplayName } from '../../features/certificates/certificates-model';

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
