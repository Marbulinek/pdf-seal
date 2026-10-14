import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import type { ValidationStatus } from '../core/models';
import { CertBadge } from './cert-badge';

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
