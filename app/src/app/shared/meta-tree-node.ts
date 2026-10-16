import { ChangeDetectionStrategy, Component, computed, input, linkedSignal } from '@angular/core';
import { MetaHighlight } from './meta-highlight';
import { isExpandableMetaValue, metaEntriesOf, type MetaValue } from './meta-value';

/**
 * One tree node. Branches render their children only once opened -- a
 * collapsed <details> of hundreds of raw objects then costs nothing. Only the
 * top couple of levels open automatically on a search.
 */
@Component({
  selector: 'app-meta-tree-node',
  imports: [MetaHighlight],
  template: `
    @let v = value();
    @if (branch(); as b) {
      <details class="meta-branch" [attr.data-depth]="depth()" [open]="open()" (toggle)="onToggle($event)">
        <summary>
          <span class="meta-key"><app-meta-highlight [text]="key()" [term]="term()" /></span><span class="meta-count">{{ entries().length }}</span>
        </summary>
        <div class="meta-branch-body">
          @if (open() || rendered()) {
            @for (entry of entries(); track entry[0]) {
              <app-meta-tree-node [key]="entry[0]" [value]="entry[1]" [depth]="depth() + 1" [term]="term()" [forceOpen]="forceOpen()" />
            } @empty {
              <div class="meta-leaf"><span class="meta-value">Empty</span></div>
            }
          }
        </div>
      </details>
    } @else {
      <div class="meta-leaf" [attr.data-depth]="depth()">
        <span class="meta-key"><app-meta-highlight [text]="key()" [term]="term()" /></span>
        <span class="meta-value"><app-meta-highlight [text]="v === null || v === undefined || v === '' ? '—' : '' + v" [term]="term()" /></span>
      </div>
    }
  `,
  styleUrl: './meta-tree-node.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: 'display: contents' },
})
export class MetaTreeNode {
  readonly key = input.required<string>();
  readonly value = input.required<MetaValue>();
  readonly depth = input(0);
  readonly term = input('');
  readonly forceOpen = input(false);
  /** Name of the top-level branch that opens by default (e.g. "Document Metadata"). */
  readonly openKey = input<string | null>(null);

  protected readonly branch = computed(() => {
    const v = this.value();
    return isExpandableMetaValue(v) ? v : null;
  });
  protected readonly entries = computed(() => {
    const b = this.branch();
    return b ? metaEntriesOf(b) : [];
  });
  protected readonly open = linkedSignal(
    () => this.forceOpen() || (!!this.term() && this.depth() < 2) || (this.depth() === 0 && this.key() === this.openKey()),
  );
  /** Once rendered, keep children around when collapsed again (cheap, keeps nested open state). */
  protected readonly rendered = linkedSignal<boolean>(() => this.open());

  protected onToggle(event: Event): void {
    const isOpen = (event.target as HTMLDetailsElement).open;
    if (isOpen === this.open()) return;
    this.open.set(isOpen);
    if (isOpen) this.rendered.set(true);
  }
}
