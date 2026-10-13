import { ChangeDetectionStrategy, Component, computed, input, linkedSignal } from '@angular/core';

/** Anything the tree can show: plain JSON-shaped data. */
export type MetaValue = string | number | boolean | null | undefined | MetaValue[] | { [key: string]: MetaValue };
type MetaBranch = MetaValue[] | { [key: string]: MetaValue };

export function isExpandableMetaValue(value: MetaValue): value is MetaBranch {
  return value !== null && typeof value === 'object';
}

export function metaEntriesOf(node: MetaBranch): [string, MetaValue][] {
  return Array.isArray(node) ? node.map((v, i): [string, MetaValue] => [`[${i}]`, v]) : Object.entries(node);
}

/** Keeps only the branches/leaves whose key or value matches `term` (lower-cased). */
export function filterMetaTree(node: MetaBranch, term: string): MetaBranch {
  const out: MetaValue[] = [];
  const record: { [key: string]: MetaValue } = {};
  const isArrayNode = Array.isArray(node);
  for (const [key, value] of metaEntriesOf(node)) {
    const keyMatches = key.toLowerCase().includes(term);
    const put = (v: MetaValue) => (isArrayNode ? out.push(v) : (record[key] = v));
    if (isExpandableMetaValue(value)) {
      if (keyMatches) put(value);
      else {
        const child = filterMetaTree(value, term);
        if ((Array.isArray(child) ? child.length : Object.keys(child).length) > 0) put(child);
      }
    } else if (keyMatches || String(value).toLowerCase().includes(term)) {
      put(value);
    }
  }
  return isArrayNode ? out : record;
}

export interface HighlightParts {
  before: string;
  match: string;
  after: string;
}

/** Splits `text` around the first case-insensitive occurrence of `term`. */
export function highlightParts(text: string, term: string): HighlightParts {
  if (!term) return { before: text, match: '', after: '' };
  const idx = text.toLowerCase().indexOf(term.toLowerCase());
  if (idx === -1) return { before: text, match: '', after: '' };
  return { before: text.slice(0, idx), match: text.slice(idx, idx + term.length), after: text.slice(idx + term.length) };
}

@Component({
  selector: 'app-meta-highlight',
  template: `{{ parts().before }}@if (parts().match) {<mark class="meta-highlight">{{ parts().match }}</mark>}{{ parts().after }}`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MetaHighlight {
  readonly text = input.required<string>();
  readonly term = input('');
  protected readonly parts = computed(() => highlightParts(this.text(), this.term()));
}

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
