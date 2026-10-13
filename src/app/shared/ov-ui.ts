import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import type { ValidationStatus } from '../core/models';
import { ovShortDate } from '../core/util/format';
import { CERT_STATUS_GLYPH, CERT_STATUS_WORD, type EvidenceRow } from '../features/certificates/certificates-model';

// The Overview's visual vocabulary -- a hero card, label-above-value fact
// tiles and yes/no flag chips -- shared by every section's right panel.

export type PillTone = 'positive' | 'pending' | 'neutral' | 'warning' | 'negative';

export type HeroBadge = { type: 'pill'; text: string; tone: PillTone } | { type: 'cert'; status: ValidationStatus } | null;

export interface HeroModel {
  /** Drives the `is-<kind>` tint. */
  kind: string;
  label: string;
  subtitle?: string | null;
  /** Initials shown instead of the icon. */
  avatar?: string | null;
  icon: string;
  badge?: HeroBadge;
}

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

@Component({
  selector: 'app-ov-hero',
  imports: [CertBadge],
  template: `
    @let h = hero();
    <div class="ov-hero is-{{ h.kind }}">
      @if (h.avatar) {
        <span class="ov-hero-lead is-avatar" aria-hidden="true">{{ h.avatar }}</span>
      } @else {
        <span class="ov-hero-lead" aria-hidden="true"><span class="icon {{ h.icon }}"></span></span>
      }
      <div class="ov-hero-main">
        <p class="ov-hero-label">{{ h.label }}</p>
        @if (h.subtitle) {
          <p class="ov-hero-sub">{{ h.subtitle }}</p>
        }
      </div>
      @if (h.badge; as badge) {
        @if (badge.type === 'cert') {
          <app-cert-badge [status]="badge.status" />
        } @else {
          <span class="ov-pill is-{{ badge.tone }}">{{ badge.text }}</span>
        }
      }
      <ng-content />
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: 'display: contents' },
})
export class OvHero {
  readonly hero = input.required<HeroModel>();
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

/** Yes/no properties as one row of chips instead of a "Required: No" row each. */
@Component({
  selector: 'app-ov-flags',
  template: `
    <ul class="ov-flags">
      @for (f of flags(); track f[0]) {
        <li class="ov-flag" [class.is-on]="f[1]">
          <span class="icon {{ f[1] ? 'icon-check' : 'icon-minus' }}" aria-hidden="true"></span>{{ f[0] }}<span class="sr-only">: {{ f[1] ? 'yes' : 'no' }}</span>
        </li>
      }
    </ul>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: 'display: contents' },
})
export class OvFlags {
  readonly flags = input.required<[string, boolean][]>();
}

@Component({
  selector: 'app-ov-section-title',
  template: `<p class="overview-section-title"><span class="icon {{ icon() }}" aria-hidden="true"></span> {{ title() }}</p>`,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: 'display: contents' },
})
export class OvSectionTitle {
  readonly icon = input.required<string>();
  readonly title = input.required<string>();
}

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
