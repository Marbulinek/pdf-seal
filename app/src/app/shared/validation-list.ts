import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import type { ValidationResult } from '../core/models';
import type { CheckSource } from '../features/certificates/certificates-model';
import { CertDot } from './cert-dot';

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
