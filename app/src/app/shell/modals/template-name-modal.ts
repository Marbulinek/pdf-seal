import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, untracked, viewChild } from '@angular/core';
import { TemplatesStore } from '../../features/signatures/templates.store';
import { isBackdropClick } from './backdrop-click';

/** Create / rename a signature template -- the only text a template needs. */
@Component({
  selector: 'div[appTemplateNameModal]',
  template: `
    <div class="modal-box template-name-modal-box" role="dialog" aria-modal="true" aria-labelledby="templateNameTitle">
      <div class="modal-header">
        <h3 id="templateNameTitle">{{ editing() ? 'Rename template' : 'New signature template' }}</h3>
        <button type="button" class="modal-close" id="closeTemplateNameBtn" aria-label="Close" (click)="templates.closeNameModal()">
          <span class="icon icon-close" aria-hidden="true"></span>
        </button>
      </div>
      <p class="modal-hint" id="templateNameHint">{{ hint() }}</p>

      <div class="form-group">
        <label for="templateNameInput">Template name</label>
        <input
          #nameInput
          type="text"
          id="templateNameInput"
          placeholder="e.g. Contract — 2 signers"
          autocomplete="off"
          spellcheck="false"
          (keydown.enter)="submit($event)"
        />
      </div>

      <div class="modal-status" [class.error]="!!templates.nameModal().status" id="templateNameStatus">{{ templates.nameModal().status }}</div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" id="cancelTemplateNameBtn" (click)="templates.closeNameModal()">Cancel</button>
        <button type="button" class="btn btn-primary" id="saveTemplateNameBtn" (click)="submit()">
          <span class="icon icon-check" aria-hidden="true"></span> <span id="saveTemplateNameLabel">{{ editing() ? 'Save name' : 'Create template' }}</span>
        </button>
      </div>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    id: 'templateNameModal',
    class: 'modal-backdrop',
    '[class.is-open]': 'templates.nameModal().open',
    '[attr.aria-hidden]': '!templates.nameModal().open',
    '(click)': 'onBackdrop($event)',
  },
})
export class TemplateNameModal {
  protected readonly templates = inject(TemplatesStore);
  private readonly nameInput = viewChild.required<ElementRef<HTMLInputElement>>('nameInput');

  protected readonly editing = computed(() => {
    const id = this.templates.nameModal().editingId;
    return id ? (this.templates.templates().find((t) => t.id === id) ?? null) : null;
  });

  protected readonly hint = computed(() => {
    if (this.editing()) return 'Only the label changes — the fields saved in this template stay exactly as they are.';
    const captured = this.templates.capturedFieldName();
    return captured
      ? `Name the template and "${captured}" goes straight into it. Drag your other fields in the same way to fill it out.`
      : 'Give the template a name. To fill it, place fields on your document as usual, then drag each one into the Signature Templates panel.';
  });

  constructor() {
    effect(() => {
      if (!this.templates.nameModal().open) return;
      untracked(() => {
        const el = this.nameInput().nativeElement;
        el.value = this.editing()?.name ?? '';
        setTimeout(() => {
          el.focus();
          el.select();
        }, 0);
      });
    });
  }

  protected submit(event?: Event): void {
    event?.preventDefault();
    this.templates.submitTemplateName(this.nameInput().nativeElement.value);
  }

  protected onBackdrop(event: MouseEvent): void {
    if (isBackdropClick(event)) this.templates.closeNameModal();
  }
}
