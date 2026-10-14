import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { MetaTreeNode } from './meta-tree-node';
import { filterMetaTree, isExpandableMetaValue, metaEntriesOf, type MetaValue } from './meta-value';

/** A filtered tree of `node`'s entries, with "No matches." / "Empty." fallbacks. */
@Component({
  selector: 'app-meta-tree',
  imports: [MetaTreeNode],
  template: `
    @if (root() === null) {
      <p class="diff-empty-note">{{ missingText() }}</p>
    } @else if (!entries().length) {
      <p class="diff-empty-note">{{ term() ? 'No matches.' : 'Empty.' }}</p>
    } @else {
      <div class="meta-tree">
        @for (entry of entries(); track entry[0]) {
          <app-meta-tree-node [key]="entry[0]" [value]="entry[1]" [depth]="0" [term]="term()" [openKey]="openKey()" />
        }
      </div>
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: 'display: contents' },
})
export class MetaTree {
  readonly node = input.required<MetaValue>();
  readonly term = input('');
  readonly openKey = input<string | null>(null);
  readonly missingText = input('Not present on this side.');

  protected readonly root = computed(() => {
    const n = this.node();
    return isExpandableMetaValue(n) ? n : null;
  });
  protected readonly entries = computed(() => {
    const root = this.root();
    if (!root) return [];
    const term = this.term().toLowerCase();
    return metaEntriesOf(term ? filterMetaTree(root, term) : root);
  });
}
