import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

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
