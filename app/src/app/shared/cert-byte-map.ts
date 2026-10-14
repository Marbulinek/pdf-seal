import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import type { ByteMap } from '../features/certificates/certificates-model';

/** Two thin bars: what the signature covers, and how full its /Contents slot is. */
@Component({
  selector: 'app-cert-bytemap',
  template: `
    @let m = map();
    <div class="cert-bytemap">
      <div class="cert-bytemap-row">
        <span class="cert-bytemap-label">File coverage</span>
        <div class="cert-bytemap-bar">
          @for (s of m.segments; track $index) {
            <span class="cert-bytemap-seg {{ s.cls }}" [style.width.%]="s.width" [title]="s.label"></span>
          }
        </div>
      </div>
      @if (m.trailingNote) {
        <p class="cert-bytemap-note">{{ m.trailingNote }}</p>
      }
      <div class="cert-bytemap-row">
        <span class="cert-bytemap-label">Slot occupancy</span>
        <div class="cert-bytemap-bar">
          <span class="cert-bytemap-seg is-occupied" [style.width.%]="m.occupiedPct" [title]="m.occupiedLabel"></span>
          <span class="cert-bytemap-seg is-headroom" [style.width.%]="m.headroomPct" [title]="m.headroomLabel"></span>
        </div>
      </div>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: 'display: contents' },
})
export class CertByteMap {
  readonly map = input.required<ByteMap>();
}
