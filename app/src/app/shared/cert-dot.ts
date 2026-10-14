import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { ValidationStatus } from '../core/models';
import { CERT_STATUS_GLYPH } from '../features/certificates/certificates-model';

@Component({
  selector: 'app-cert-dot',
  template: `<span class="cert-status-dot is-{{ status() }}" aria-hidden="true">{{ glyph() }}</span>`,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: 'display: contents' },
})
export class CertDot {
  readonly status = input.required<ValidationStatus>();
  protected readonly glyph = computed(() => CERT_STATUS_GLYPH[this.status()] ?? '?');
}
