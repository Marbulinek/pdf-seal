import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { ValidationStatus } from '../core/models';
import { CERT_STATUS_GLYPH } from '../features/certificates/certificates-model';

/** "✕ 2  ! 1  ✓ 9" -- counts per status, worst first. */
@Component({
  selector: 'app-check-counts',
  template: `
    @for (c of counts(); track c.status) {
      <span class="cert-check-count is-{{ c.status }}">{{ c.glyph }} {{ c.count }}</span>
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: 'display: contents' },
})
export class CheckCounts {
  readonly checks = input.required<{ status: ValidationStatus }[]>();
  protected readonly counts = computed(() => {
    const counts: Record<ValidationStatus, number> = { fail: 0, warn: 0, unknown: 0, pass: 0 };
    for (const check of this.checks()) counts[check.status] += 1;
    return (['fail', 'warn', 'unknown', 'pass'] as const)
      .filter((status) => counts[status])
      .map((status) => ({ status, count: counts[status], glyph: CERT_STATUS_GLYPH[status] }));
  });
}
