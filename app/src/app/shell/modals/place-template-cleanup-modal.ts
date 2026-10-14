import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { pluralize } from '../../core/util/format';
import { TemplatesStore } from '../../features/signatures/templates.store';
import { isBackdropClick } from './backdrop-click';

/** Before an auto-placement batch onto a document that already has unsigned signature fields. */
@Component({
  selector: 'div[appPlaceTemplateCleanupModal]',
  template: `
    <div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="placeTemplateCleanupTitle">
      <div class="modal-header">
        <h3 id="placeTemplateCleanupTitle">Existing fields on this document</h3>
        <button type="button" class="modal-close" id="closePlaceTemplateCleanupBtn" aria-label="Close" (click)="templates.closeCleanup()">
          <span class="icon icon-close" aria-hidden="true"></span>
        </button>
      </div>
      <p class="modal-hint" id="placeTemplateCleanupHint">{{ hint() }}</p>
      <div class="place-template-choices" id="placeTemplateCleanupChoices">
        @for (opt of options(); track opt.value) {
          <label class="place-template-choice" [class.is-selected]="opt.value === selected()" [class.is-disabled]="!!opt.disabled">
            <input
              type="radio"
              name="placeTemplateCleanup"
              [value]="opt.value"
              [checked]="opt.value === selected()"
              [disabled]="!!opt.disabled"
              (change)="templates.setCleanupValue(opt.value)"
            />
            <span>
              <strong>{{ opt.title }}</strong>
              <span class="place-template-choice-meta">{{ opt.desc }}</span>
            </span>
          </label>
        }
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" id="cancelPlaceTemplateCleanupBtn" (click)="templates.closeCleanup()">Cancel</button>
        <button type="button" class="btn btn-primary" id="confirmPlaceTemplateCleanupBtn" (click)="templates.confirmCleanup()">Continue</button>
      </div>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    id: 'placeTemplateCleanupModal',
    class: 'modal-backdrop',
    '[class.is-open]': '!!templates.cleanup()',
    '[attr.aria-hidden]': '!templates.cleanup()',
    '(click)': 'onBackdrop($event)',
  },
})
export class PlaceTemplateCleanupModal {
  protected readonly templates = inject(TemplatesStore);
  protected readonly options = computed(() => this.templates.cleanupOptions());
  /** Falls back to "keep" when the picked option is disabled. */
  protected readonly selected = computed(() => {
    const value = this.templates.cleanup()?.value ?? 'none';
    return this.options().some((o) => o.value === value && !o.disabled) ? value : 'none';
  });
  protected readonly hint = computed(() => {
    const cleanup = this.templates.cleanup();
    if (!cleanup) return '';
    const name = this.templates.templates().find((t) => t.id === cleanup.templateId)?.name;
    return `“${name}” is about to add to a document that already has ${pluralize(cleanup.docSig, 'unsigned signature field')}. Choose what happens to them.`;
  });

  protected onBackdrop(event: MouseEvent): void {
    if (isBackdropClick(event)) this.templates.closeCleanup();
  }
}
