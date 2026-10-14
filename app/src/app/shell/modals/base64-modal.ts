import { ChangeDetectionStrategy, Component, ElementRef, effect, inject, linkedSignal, untracked, viewChild } from '@angular/core';
import { DocumentService } from '../../core/document.service';
import { UiService } from '../../core/ui.service';
import { analyzeBase64Pdf, formatBase64Text, quickCheckBase64Header } from '../../core/util/base64';
import { isBackdropClick } from './simple-modals';

type Base64Validity = 'idle' | 'valid' | 'invalid';

const VALIDITY_COPY: Record<Base64Validity, { icon: string; text: string }> = {
  idle: { icon: 'icon-info-circle', text: 'Insert base64 string to validate' },
  valid: { icon: 'icon-check-circle', text: 'Valid Base64 PDF' },
  invalid: { icon: 'icon-alert-circle', text: 'Not a valid PDF' },
};

/** "Upload as Base64": paste a (data: URL or bare) Base64 PDF and load it. */
@Component({
  selector: 'div[appBase64Modal]',
  template: `
    <div class="modal-box">
      <div class="modal-header">
        <h3>Upload as Base64</h3>
        <button type="button" class="modal-close" id="closeBase64ModalBtn" aria-label="Close" (click)="close()">
          <span class="icon icon-close" aria-hidden="true"></span>
        </button>
      </div>
      <p class="modal-hint">
        Paste a Base64-encoded PDF below — with or without the <code>data:application/pdf;base64,</code> prefix. Leading/trailing
        <code>"</code> or <code>'</code> characters are removed automatically.
      </p>
      <div class="modal-textarea-toolbar">
        <span class="base64-validity is-{{ validity() }}" id="base64Validity">
          <span class="icon base64-validity-icon {{ copy[validity()].icon }}" aria-hidden="true"></span>
          <span class="base64-validity-text">{{ copy[validity()].text }}</span>
        </span>
      </div>
      <textarea
        #input
        class="modal-textarea"
        id="base64Input"
        placeholder="JVBERi0xLjQK..."
        spellcheck="false"
        [value]="text()"
        (input)="onInput(input.value)"
        (paste)="onPaste()"
      ></textarea>
      <div class="modal-status {{ status()?.type ?? '' }}" id="base64ModalStatus">{{ status()?.message }}</div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" id="cancelBase64Btn" (click)="close()">Cancel</button>
        <button type="button" class="btn btn-primary" id="loadBase64Btn" (click)="load()">Load Document</button>
      </div>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    id: 'base64UploadModal',
    class: 'modal-backdrop',
    '[class.is-open]': 'ui.base64ModalOpen()',
    '(click)': 'onBackdrop($event)',
  },
})
export class Base64Modal {
  protected readonly ui = inject(UiService);
  private readonly documents = inject(DocumentService);
  private readonly input = viewChild.required<ElementRef<HTMLTextAreaElement>>('input');

  protected readonly copy = VALIDITY_COPY;
  // Every open starts from a blank form (closing keeps the last state for the fade-out).
  protected readonly text = this.resetOnOpen('');
  protected readonly validity = this.resetOnOpen<Base64Validity>('idle');
  protected readonly status = this.resetOnOpen<{ message: string; type: 'error' | 'success' } | null>(null);
  private validityTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    effect(() => {
      if (!this.ui.base64ModalOpen()) return;
      untracked(() => {
        this.input().nativeElement.value = '';
        // After the backdrop starts fading in: a `visibility: hidden` element can't take focus.
        setTimeout(() => this.input().nativeElement.focus(), 50);
      });
    });
  }

  private resetOnOpen<T>(initial: T) {
    return linkedSignal<boolean, T>({
      source: this.ui.base64ModalOpen,
      computation: (open, previous) => (open || !previous ? initial : previous.value),
    });
  }

  protected close(): void {
    this.ui.base64ModalOpen.set(false);
  }

  protected onBackdrop(event: MouseEvent): void {
    if (isBackdropClick(event)) this.close();
  }

  protected onInput(value: string): void {
    this.text.set(value);
    // Re-validated on a debounce: a Base64 PDF can be tens of megabytes.
    if (this.validityTimer) clearTimeout(this.validityTimer);
    this.validityTimer = setTimeout(() => this.checkValidity(), 200);
  }

  protected onPaste(): void {
    setTimeout(() => {
      const el = this.input().nativeElement;
      const formatted = formatBase64Text(el.value);
      el.value = formatted;
      this.text.set(formatted);
      el.setSelectionRange(formatted.length, formatted.length);
      this.checkValidity();
    }, 0);
  }

  private checkValidity(): void {
    const raw = this.text();
    if (!raw.trim()) {
      this.validity.set('idle');
      return;
    }
    try {
      this.validity.set(quickCheckBase64Header(raw) ? 'valid' : 'invalid');
    } catch {
      this.validity.set('invalid');
    }
  }

  protected load(): void {
    const raw = this.input().nativeElement.value;
    if (!raw.trim()) {
      this.status.set({ message: 'Paste a Base64 string first.', type: 'error' });
      return;
    }
    let result: ReturnType<typeof analyzeBase64Pdf>;
    try {
      result = analyzeBase64Pdf(raw);
    } catch {
      this.status.set({ message: "That doesn't look like valid Base64.", type: 'error' });
      return;
    }
    if (!result.isPdf) {
      this.status.set({ message: 'Decoded data does not look like a PDF file.', type: 'error' });
      return;
    }
    const file = new File([result.bytes as BlobPart], 'uploaded-document.pdf', { type: 'application/pdf' });
    this.status.set({ message: 'Loading document...', type: 'success' });
    this.close();
    void this.documents.processNewFile(file);
  }
}
