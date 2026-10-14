import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import type { EvidenceRow } from '../features/certificates/certificates-model';
import { CertDot } from './cert-dot';

/**
 * Signature evidence card: one row per fact, status dot on the left, label
 * above the value. A row's "Show changes after signing" button appears only
 * when `nativeChain(to)` says the stored versions are this file's own chain.
 */
@Component({
  selector: 'app-evidence',
  imports: [CertDot],
  template: `
    <div class="evidence">
      @for (r of rows(); track r.label) {
        <div class="evidence-row">
          @if (r.status) {
            <app-cert-dot [status]="r.status" />
          } @else {
            <span class="evidence-dot" aria-hidden="true">i</span>
          }
          <div class="evidence-main">
            <span class="evidence-label">{{ r.label }}</span><span class="evidence-text">{{ r.text }}</span>
            @if (r.slot; as slot) {
              <span class="evidence-action" data-evidence-slot="after-signing" [attr.data-from]="slot.from" [attr.data-to]="slot.to">
                @if (nativeChain()[slot.to]) {
                  <button type="button" class="btn btn-ghost btn-small" data-evidence-action="compare-versions" (click)="compare.emit(slot)">
                    Show changes after signing
                  </button>
                }
              </span>
            }
          </div>
        </div>
      }
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: 'display: contents' },
})
export class Evidence {
  readonly rows = input.required<EvidenceRow[]>();
  readonly nativeChain = input<Record<number, boolean>>({});
  readonly compare = output<{ from: number; to: number }>();
}
