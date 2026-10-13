import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import type { ValidityTimeline as TimelineModel } from '../features/certificates/certificates-model';

/** Each chain certificate's validity window, the signing/timestamp markers and "now". */
@Component({
  selector: 'app-validity-timeline',
  template: `
    @let t = timeline();
    <div class="cert-timeline" [class.cert-timeline-large]="large()">
      @if (!large()) {
        <div class="cert-timeline-head">
          <p class="cert-timeline-title">Validity timeline</p>
          <button
            type="button"
            class="btn btn-ghost btn-small cert-timeline-expand"
            data-cert-action="expand-timeline"
            [attr.data-cert-signature-field]="fieldName()"
            (click)="expand.emit()"
          >
            Expand <span class="icon icon-chevron-right" aria-hidden="true"></span>
          </button>
        </div>
      }
      <div class="cert-timeline-scroll-wrap">
        <div class="cert-timeline-scroll">
          @for (row of t.rows; track $index) {
            <div class="cert-timeline-row">
              <span class="cert-timeline-row-label" [title]="row.name">{{ row.name }}</span>
              <div class="cert-timeline-track">
                <span class="cert-timeline-bar is-{{ row.status }}" [style.left.%]="row.left" [style.width.%]="row.width" [title]="row.title"></span>
              </div>
            </div>
          }
          @for (m of t.markers; track m.cls) {
            <div class="cert-timeline-row cert-timeline-marker-row">
              <span class="cert-timeline-row-label">{{ m.label }}</span>
              <div class="cert-timeline-track">
                <span class="cert-timeline-marker {{ m.cls }}" [style.left.%]="m.left" [title]="m.note"></span>
              </div>
            </div>
          }
          <div class="cert-timeline-now-overlay">
            <div class="cert-timeline-now" [style.left]="t.nowLeft + '%'" [title]="t.nowTitle">
              <span class="cert-timeline-now-label">Now</span>
            </div>
          </div>
          <div class="cert-timeline-axis">
            @for (tick of t.ticks; track tick.align) {
              <span class="cert-timeline-tick cert-timeline-tick-{{ tick.align }}" [style.left]="tick.left + '%'">{{ tick.label }}</span>
            }
          </div>
        </div>
      </div>
      <div class="cert-timeline-legend">
        <span class="cert-timeline-legend-item"><span class="cert-timeline-legend-swatch is-pass"></span>Certificate valid</span>
        <span class="cert-timeline-legend-item"><span class="cert-timeline-legend-swatch is-warn"></span>Expiring soon</span>
        <span class="cert-timeline-legend-item"><span class="cert-timeline-legend-swatch is-fail"></span>Expired / not yet valid</span>
        <span class="cert-timeline-legend-item"><span class="cert-timeline-legend-swatch is-unknown"></span>Unknown</span>
        @if (t.hasClaimed) {
          <span class="cert-timeline-legend-item"><span class="cert-timeline-legend-dot is-claimed"></span>Signed (claimed)</span>
        }
        @if (t.hasTimestamp) {
          <span class="cert-timeline-legend-item"><span class="cert-timeline-legend-dot is-timestamp"></span>Timestamped</span>
        }
        <span class="cert-timeline-legend-item"><span class="cert-timeline-legend-dot is-now"></span>Now</span>
      </div>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: 'display: contents' },
})
export class ValidityTimeline {
  readonly timeline = input.required<TimelineModel>();
  readonly large = input(false);
  readonly fieldName = input('');
  readonly expand = output<void>();
}
