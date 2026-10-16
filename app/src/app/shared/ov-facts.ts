import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { ovShortDate } from '../core/util/format';

export interface FactModel {
  label: string;
  value: string | null | undefined;
  wide?: boolean;
  /** Renders as <time> with the date and a smaller time. */
  date?: boolean;
  /** 0-100: renders a small meter before the value. */
  meter?: number;
  /** A smaller second line after the value (e.g. "Portrait · 210 × 297 mm"). */
  sub?: string;
}

/** A date fact, or one that's dropped (null value) when the date doesn't parse. */
export function dateFact(label: string, value: string | null | undefined, wide = false): FactModel {
  const d = value ? new Date(value) : null;
  if (!d || Number.isNaN(d.getTime())) return { label, value: null, wide };
  return { label, value: d.toISOString(), date: true, wide };
}

@Component({
  selector: 'app-ov-facts',
  template: `
    @if (items().length) {
      <dl class="ov-facts">
        @for (f of items(); track f.label) {
          <div class="ov-fact" [class.is-wide]="!!f.wide">
            <dt>{{ f.label }}</dt>
            <dd>
              @if (f.date) {
                <time [attr.datetime]="f.value">{{ shortDate(f.value) }} <span class="ov-fact-sub">{{ time(f.value) }}</span></time>
              } @else if (f.meter !== undefined) {
                <span class="ov-meter" aria-hidden="true"><span [style.width.%]="f.meter"></span></span> {{ f.value }}
              } @else {
                {{ f.value }}
                @if (f.sub) {
                  <span class="ov-fact-sub">{{ f.sub }}</span>
                }
              }
            </dd>
          </div>
        }
      </dl>
    }
  `,
  styleUrl: './ov-facts.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: 'display: contents' },
})
export class OvFacts {
  readonly facts = input.required<FactModel[]>();
  protected readonly items = computed(() => this.facts().filter((f) => f.value !== null && f.value !== undefined && f.value !== ''));

  protected shortDate(value: string | null | undefined): string {
    return ovShortDate(value ?? null);
  }

  protected time(value: string | null | undefined): string {
    if (!value) return '';
    return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value));
  }
}
