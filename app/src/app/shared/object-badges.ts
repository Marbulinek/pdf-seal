import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { isRectPracticallyInvisible } from '../core/field-rules';
import type { RawObjectPreview } from '../core/models';
import { CLASSIFICATION_BADGES } from '../features/versions/versions-model';

export const INVISIBLE_FIELD_TITLE =
  "This field's /Rect is at or near zero size, so it has no visible footprint on the page — it's marked with a small pin at its actual position instead.";

/** True when every rect of a raw object is at or near zero size. */
export function isInvisibleObject(item: Pick<RawObjectPreview, 'rects'>): boolean {
  return item.rects.length > 0 && item.rects.every((r) => isRectPracticallyInvisible(r));
}

/** The classification / category / invisible-field badges of a raw object. */
@Component({
  selector: 'app-object-badges',
  template: `
    @if (withCategory() && item().category) {
      <span class="diff-object-badge">{{ item().category }}</span>
    }
    @for (b of badges(); track b.label) {
      <span class="diff-object-badge {{ b.cls }}">{{ b.label }}</span>
    }
    @if (invisible()) {
      <span class="diff-object-badge badge-invisible" [title]="invisibleTitle()"
        ><span class="icon icon-eye-off" aria-hidden="true"></span> Invisible field</span
      >
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: 'display: contents' },
})
export class ObjectBadges {
  readonly item = input.required<RawObjectPreview>();
  readonly withCategory = input(false);
  readonly invisibleTitle = input(INVISIBLE_FIELD_TITLE);
  protected readonly badges = computed(() =>
    this.item()
      .classifications.map((c) => CLASSIFICATION_BADGES[c])
      .filter((b): b is { label: string; cls: string } => !!b),
  );
  protected readonly invisible = computed(() => isInvisibleObject(this.item()));
}
