import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { FIELD_KEY_DESCRIPTIONS, FIELD_KEY_LABELS } from '../../core/field-keys';
import { UiService } from '../../core/ui.service';

/**
 * Raw-property explainer, opened from Field Details and the raw-object
 * inspector. Kept at body level: it is position:fixed, and a transform on a
 * sheet would otherwise become its containing block.
 */
@Component({
  selector: 'div[appFieldInfoModal]',
  template: `
    <div class="field-info-overlay">
      <div class="modal-box field-info-modal-box">
        <div class="modal-header">
          <h3 id="fieldInfoTitle">{{ title() }}</h3>
          <button type="button" class="modal-close" id="closeFieldInfoModalBtn" aria-label="Close" (click)="ui.fieldInfoKey.set(null)">
            <span class="icon icon-close" aria-hidden="true"></span>
          </button>
        </div>
        <!-- Static, trusted explainer HTML authored in core/field-keys.ts. -->
        <div class="field-info-body" id="fieldInfoBody" [innerHTML]="description()"></div>
      </div>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    id: 'fieldInfoModal',
    class: 'modal-backdrop info-modal',
    '[class.is-open]': 'ui.fieldInfoKey() !== null',
    '(click)': 'onBackdrop($event)',
  },
})
export class FieldInfoModal {
  protected readonly ui = inject(UiService);
  protected readonly title = computed(() => {
    const key = this.ui.fieldInfoKey() ?? '';
    return FIELD_KEY_LABELS[key] || key || 'Property details';
  });
  protected readonly description = computed(
    () => FIELD_KEY_DESCRIPTIONS[this.ui.fieldInfoKey() ?? ''] || 'No description is available for this PDF property yet.',
  );

  protected onBackdrop(event: MouseEvent): void {
    // The box sits inside .field-info-overlay, which fills the backdrop.
    const target = event.target as HTMLElement;
    if (target === event.currentTarget || target.classList.contains('field-info-overlay')) this.ui.fieldInfoKey.set(null);
  }
}
