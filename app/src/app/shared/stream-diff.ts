import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { StreamDiffResult } from '../core/models';

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
