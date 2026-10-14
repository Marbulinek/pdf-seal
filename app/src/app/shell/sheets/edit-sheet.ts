import { DOCUMENT } from '@angular/common';
import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, untracked, viewChild } from '@angular/core';
import { DocumentStore } from '../../core/document.store';
import { ANNOTATION_FLAG_BITS, FIELD_FLAG_BITS, FIELD_KEY_LABELS, decodeFlags } from '../../core/field-keys';
import { isEditableField } from '../../core/field-rules';
import { UiService } from '../../core/ui.service';
import { SignaturesStore } from '../../features/signatures/signatures.store';

const RECT_INPUT_IDS = ['editX', 'editY', 'editWidth', 'editHeight'];

interface FieldDetailRow {
  key: string;
  label: string;
  value: string;
  flags: string[];
}

/**
 * The Edit sheet slides in over the column while a field is selected and out
 * on deselect -- selection is the only thing that opens it, so the sheet and
 * the overlay's `.active` outline can never disagree.
 */
@Component({
  selector: 'aside[appEditSheet]',
  templateUrl: './edit-sheet.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    id: 'editSheet',
    class: 'edit-sheet',
    tabindex: '-1',
    'aria-labelledby': 'editSheetTitle',
    '[class.is-open]': 'ui.sheets.edit()',
    '[class.is-suppressed]': 'signatures.editSheetSuppressed()',
    '[attr.aria-hidden]': '!ui.sheets.edit()',
  },
})
export class EditSheet {
  protected readonly ui = inject(UiService);
  protected readonly doc = inject(DocumentStore);
  protected readonly signatures = inject(SignaturesStore);
  private readonly document = inject(DOCUMENT);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  private readonly nameInput = viewChild.required<ElementRef<HTMLInputElement>>('nameInput');
  private readonly xInput = viewChild.required<ElementRef<HTMLInputElement>>('xInput');
  private readonly yInput = viewChild.required<ElementRef<HTMLInputElement>>('yInput');
  private readonly wInput = viewChild.required<ElementRef<HTMLInputElement>>('wInput');
  private readonly hInput = viewChild.required<ElementRef<HTMLInputElement>>('hInput');

  protected readonly field = this.signatures.activeField;
  protected readonly editable = computed(() => {
    const f = this.field();
    return !!f && isEditableField(f);
  });
  /** Every control is read-only without a selection or for a non-editable (signed / non-signature) field. */
  protected readonly locked = computed(() => !this.doc.pdfDoc() || !this.editable());

  protected readonly detailRows = computed<FieldDetailRow[]>(() => {
    const raw = this.field()?.raw;
    if (!raw) return [];
    return Object.entries(raw).map(([key, value]) => ({
      key,
      label: FIELD_KEY_LABELS[key] || key,
      value,
      flags: key === 'F' ? decodeFlags(value, ANNOTATION_FLAG_BITS) : key === 'Ff' ? decodeFlags(value, FIELD_FLAG_BITS) : [],
    }));
  });

  constructor() {
    // Keep the inputs in sync with the selected field -- but never overwrite
    // the one being typed in (re-formatting "12." to "12.0" mid-keystroke).
    effect(() => {
      const f = this.field();
      untracked(() => {
        const active = this.document.activeElement;
        const set = (el: HTMLInputElement, value: string) => {
          if (el !== active) el.value = value;
        };
        set(this.nameInput().nativeElement, f?.name ?? '');
        set(this.xInput().nativeElement, f?.rect ? f.rect.x.toFixed(1) : '');
        set(this.yInput().nativeElement, f?.rect ? f.rect.y.toFixed(1) : '');
        set(this.wInput().nativeElement, f?.rect ? f.rect.width.toFixed(1) : '');
        set(this.hInput().nativeElement, f?.rect ? f.rect.height.toFixed(1) : '');
      });
    });
    // Focus the sheet (not #editName, which would swallow the keyboard) on each selection.
    effect(() => {
      const uid = this.signatures.activeFieldUid();
      const open = this.ui.sheets.edit();
      if (uid && open) untracked(() => this.host.nativeElement.focus({ preventScroll: true }));
    });
  }

  protected commitName(): void {
    const el = this.nameInput().nativeElement;
    el.value = this.signatures.renameActive(el.value);
  }

  protected onNameEnter(event: Event): void {
    event.preventDefault();
    this.commitName();
  }

  protected onRectInput(): void {
    const num = (ref: ElementRef<HTMLInputElement>) => parseFloat(ref.nativeElement.value);
    this.signatures.liveRect({ x: num(this.xInput()), y: num(this.yInput()), width: num(this.wInput()), height: num(this.hInput()) });
  }

  protected onRectBlur(event: FocusEvent): void {
    const goingTo = event.relatedTarget;
    // Tabbing between X/Y/Width/Height while editing the same field stays one undo step.
    if (goingTo instanceof HTMLElement && RECT_INPUT_IDS.includes(goingTo.id)) return;
    this.signatures.endRectEdit();
    // Re-format whatever was typed to the stored value.
    const f = this.field();
    if (f?.rect) {
      this.xInput().nativeElement.value = f.rect.x.toFixed(1);
      this.yInput().nativeElement.value = f.rect.y.toFixed(1);
      this.wInput().nativeElement.value = f.rect.width.toFixed(1);
      this.hInput().nativeElement.value = f.rect.height.toFixed(1);
    }
  }

  protected onRequiredChange(event: Event): void {
    this.signatures.setActiveRequired((event.target as HTMLInputElement).checked);
  }

  protected onDetailsToggle(event: Event): void {
    const open = (event.target as HTMLDetailsElement).open;
    if (open !== this.signatures.fieldDetailsOpen()) this.signatures.setFieldDetailsOpen(open);
  }
}
