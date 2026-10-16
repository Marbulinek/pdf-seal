import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { UiService } from '../../core/ui.service';
import { EXTENSION_STORE_URL, isGoogleChrome } from '../footer/footer';
import { isBackdropClick } from './backdrop-click';

@Component({
  selector: 'div[appExtensionModal]',
  template: `
    <div class="modal-box ext-modal-box" role="dialog" aria-modal="true" aria-labelledby="extensionModalTitle">
      <div class="modal-header">
        <h3 id="extensionModalTitle">PDF Seal Portal is here!</h3>
        <button type="button" class="modal-close" id="closeExtensionModalBtn" aria-label="Close" (click)="close()">
          <span class="icon icon-close" aria-hidden="true"></span>
        </button>
      </div>
      <img class="ext-modal-img" src="/assets/images/seal_news.webp" alt="PDF Seal mascot with news" />
      <p class="modal-hint">
        Big news: PDF Seal now has a Chrome extension! <strong>PDF Seal Portal</strong> sends any PDF you open in the browser straight into PDF
        Seal, so you can add signature fields in one click, with no downloading and re-uploading.
      </p>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" id="cancelExtensionBtn" (click)="close()">Maybe later</button>
        <a class="btn btn-primary" [href]="url" target="_blank" rel="noopener noreferrer">Get it on Chrome Web Store</a>
      </div>
    </div>
  `,
  styleUrl: './extension-modal.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    id: 'extensionModal',
    class: 'modal-backdrop',
    '[class.is-open]': 'ui.extensionModalOpen()',
    '[attr.aria-hidden]': '!ui.extensionModalOpen()',
    '(click)': 'onBackdrop($event)',
  },
})
export class ExtensionModal {
  protected readonly ui = inject(UiService);
  protected readonly url = EXTENSION_STORE_URL;

  constructor() {
    // Auto-show once per browser (Chrome only); the footer link reopens it.
    try {
      if (isGoogleChrome() && !localStorage.getItem('pdfseal-ext-modal-seen')) {
        this.ui.extensionModalOpen.set(true);
        localStorage.setItem('pdfseal-ext-modal-seen', '1');
      }
    } catch {
      /* storage blocked: skip auto-show */
    }
  }

  protected close(): void {
    this.ui.extensionModalOpen.set(false);
  }

  protected onBackdrop(event: MouseEvent): void {
    if (isBackdropClick(event)) this.close();
  }
}
