import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';
import { FIELD_KEY_LABELS } from '../core/field-keys';
import type { DictionaryChangeEntry } from '../core/models';
import { UiService } from '../core/ui.service';

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
