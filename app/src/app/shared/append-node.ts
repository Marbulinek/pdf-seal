import { Directive, ElementRef, effect, inject, input } from '@angular/core';

/**
 * Mounts an already-built DOM node (e.g. an offscreen-rendered canvas) as the
 * host's first child, replacing whatever it mounted before.
 */
@Directive({ selector: '[appAppendNode]' })
export class AppendNode {
  readonly node = input.required<Node | null>({ alias: 'appAppendNode' });
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private mounted: Node | null = null;

  constructor() {
    effect(() => {
      const node = this.node();
      const el = this.host.nativeElement;
      if (this.mounted && this.mounted !== node && this.mounted.parentNode === el) el.removeChild(this.mounted);
      if (node && node.parentNode !== el) el.insertBefore(node, el.firstChild);
      this.mounted = node;
    });
  }
}
