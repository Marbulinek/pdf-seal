import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { ValidationStatus } from '../core/models';
import { CERT_STATUS_GLYPH, CERT_STATUS_WORD } from '../features/certificates/certificates-model';

@Component({
  selector: 'app-cert-badge',
  template: `<span class="cert-badge is-{{ status() }}">{{ glyph() }} {{ word() }}</span>`,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: 'display: contents' },
})
export class CertBadge {
  readonly status = input.required<ValidationStatus>();
  protected readonly glyph = computed(() => CERT_STATUS_GLYPH[this.status()] ?? '?');
  protected readonly word = computed(() => CERT_STATUS_WORD[this.status()] ?? this.status());
}
