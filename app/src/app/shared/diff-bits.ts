import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { FIELD_KEY_LABELS } from '../core/field-keys';
import { isRectPracticallyInvisible } from '../core/field-rules';
import type { DictionaryChangeEntry, RawObjectPreview, StreamDiffResult } from '../core/models';
import { UiService } from '../core/ui.service';
import { CLASSIFICATION_BADGES } from '../features/versions/versions-model';

export const INVISIBLE_FIELD_TITLE =
  "This field's /Rect is at or near zero size, so it has no visible footprint on the page — it's marked with a small pin at its actual position instead.";

/** True when every rect of a raw object is at or near zero size. */
export function isInvisibleObject(item: Pick<RawObjectPreview, 'rects'>): boolean {
  return item.rects.length > 0 && item.rects.every((r) => isRectPracticallyInvisible(r));
}

/** "Dictionary changes": one row per added/removed/changed key, optionally with "?" explainers. */
@Component({
  selector: 'app-dictionary-changes',
  template: `
    @if (changes().length) {
      <div class="diff-object-subsection">
        <div class="diff-object-subsection-title">Dictionary changes</div>
        <div class="diff-dict-changes">
          @for (c of changes(); track c.key) {
            <div class="diff-dict-change-row">
              <span class="diff-dict-change-key">/{{ c.key }}</span>
              @if (withExplainers() && labels[c.key]) {
                <button
                  type="button"
                  class="field-details-help diff-dict-change-help"
                  [attr.data-key]="c.key"
                  [attr.aria-label]="'Explain ' + labels[c.key]"
                  (click)="ui.fieldInfoKey.set(c.key)"
                >
                  ?
                </button>
              }
              <span class="diff-dict-change-values">
                @switch (c.status) {
                  @case ('added') {
                    <span class="diff-dict-added">new: {{ c.after }}</span>
                  }
                  @case ('removed') {
                    <span class="diff-dict-removed">removed: {{ c.before }}</span>
                  }
                  @default {
                    <del>{{ c.before }}</del> → <ins>{{ c.after }}</ins>
                  }
                }
              </span>
            </div>
          }
        </div>
      </div>
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: 'display: contents' },
})
export class DictionaryChanges {
  protected readonly ui = inject(UiService);
  protected readonly labels = FIELD_KEY_LABELS;
  readonly changes = input.required<DictionaryChangeEntry[]>();
  readonly withExplainers = input(false);
}

/** "Content changes": a content stream's line diff (or why there isn't one). */
@Component({
  selector: 'app-stream-diff',
  template: `
    @if (diff(); as d) {
      @if (d.available) {
        @if (d.contentUnchanged || d.truncated || d.removed.length || d.added.length || sizeNote()) {
          <div class="diff-object-subsection">
            <div class="diff-object-subsection-title">Content changes</div>
            @if (d.contentUnchanged) {
              <p class="diff-empty-note">Decoded content is unchanged — only the compressed size differs.</p>
            } @else if (d.truncated) {
              <p class="diff-empty-note">This stream is too large to diff line-by-line here.</p>
            }
            @if (sizeNote(); as note) {
              <p class="diff-stream-size-note">{{ note }}</p>
            }
            @if (!d.contentUnchanged && !d.truncated && (d.removed.length || d.added.length)) {
              <pre class="diff-stream-diff">@for (line of d.removed; track $index) {<span class="diff-stream-line diff-stream-remove">- {{ line }}</span>
}@for (line of d.added; track $index) {<span class="diff-stream-line diff-stream-add">+ {{ line }}</span>
}</pre>
            }
          </div>
        }
      }
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: 'display: contents' },
})
export class StreamDiff {
  readonly diff = input.required<StreamDiffResult | null>();
  protected readonly sizeNote = computed(() => {
    const d = this.diff();
    if (!d || (d.rawByteLengthBefore == null && d.rawByteLengthAfter == null)) return '';
    return `Stream size: ${d.rawByteLengthBefore ?? '—'} → ${d.rawByteLengthAfter ?? '—'} bytes`;
  });
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
