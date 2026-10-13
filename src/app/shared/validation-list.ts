import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import type { ValidationResult, ValidationStatus } from '../core/models';
import { CERT_STATUS_GLYPH, type CheckSource } from '../features/certificates/certificates-model';
import { CertDot } from './ov-ui';

export type ListedCheck = ValidationResult & { source?: CheckSource };

/**
 * One row per validation check. With `showSource`, each row names where the
 * check came from and, when that is a certificate, opens it on Validation.
 */
@Component({
  selector: 'app-validation-list',
  imports: [CertDot],
  template: `
    @for (check of checks(); track $index) {
      @let source = showSource() ? (check.source ?? null) : null;
      @let openable = !!source?.certificateId;
      <div
        class="cert-check-row is-{{ check.status }}"
        [class.is-openable]="openable"
        [attr.data-cert-action]="openable ? 'open-cert' : null"
        [attr.data-cert-id]="openable ? source?.certificateId : null"
        [attr.data-cert-tab]="openable ? 'validation' : null"
        [attr.role]="openable ? 'button' : null"
        [attr.tabindex]="openable ? 0 : null"
        (click)="open(source)"
        (keydown.enter)="openKey($event, source)"
        (keydown.space)="openKey($event, source)"
      >
        <app-cert-dot [status]="check.status" />
        <div class="cert-check-text">
          @if (source) {
            <div class="cert-check-source">{{ source.label }}</div>
          }
          <div class="cert-check-label">{{ check.label }}</div>
          <div class="cert-check-detail">{{ check.detail }}</div>
          <div class="cert-check-why">{{ check.explanation }}</div>
        </div>
      </div>
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: 'display: contents' },
})
export class ValidationList {
  readonly checks = input.required<ListedCheck[]>();
  readonly showSource = input(false);
  readonly openCert = output<string>();

  protected open(source: CheckSource | null): void {
    if (source?.certificateId) this.openCert.emit(source.certificateId);
  }

  protected openKey(event: Event, source: CheckSource | null): void {
    if (!source?.certificateId) return;
    event.preventDefault();
    this.open(source);
  }
}

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
