import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { DocumentService } from '../../core/document.service';
import { DocumentStore } from '../../core/document.store';
import { FIELD_KEY_DESCRIPTIONS, FIELD_KEY_LABELS } from '../../core/field-keys';
import { UiService } from '../../core/ui.service';
import { SignaturesStore } from '../../features/signatures/signatures.store';
import { TourService } from '../../features/tour/tour.service';
import { EXTENSION_STORE_URL, isGoogleChrome } from '../footer/footer';

/** True when a click landed on the backdrop itself, not inside the box. */
export function isBackdropClick(event: MouseEvent): boolean {
  return event.target === event.currentTarget;
}

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

@Component({
  selector: 'div[appDiagnosticsModal]',
  template: `
    <div class="modal-box diagnostics-modal-box" role="dialog" aria-modal="true" aria-labelledby="diagnosticsModalTitle">
      <div class="modal-header">
        <h3 id="diagnosticsModalTitle">Diagnostics</h3>
        <button type="button" class="modal-close" id="closeDiagnosticsModalBtn" aria-label="Close" (click)="close()">
          <span class="icon icon-close" aria-hidden="true"></span>
        </button>
      </div>
      <p class="modal-hint">Include this Log ID when reporting a problem.</p>
      <div class="diagnostics-row">
        <span class="diagnostics-label">Log ID</span>
        <code class="diagnostics-value" id="diagnosticsLogId">{{ doc.documentSessionId() || 'No document open' }}</code>
      </div>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    id: 'diagnosticsModal',
    class: 'modal-backdrop',
    '[class.is-open]': 'ui.diagnosticsModalOpen()',
    '[attr.aria-hidden]': '!ui.diagnosticsModalOpen()',
    '(click)': 'onBackdrop($event)',
  },
})
export class DiagnosticsModal {
  protected readonly ui = inject(UiService);
  protected readonly doc = inject(DocumentStore);

  protected close(): void {
    this.ui.diagnosticsModalOpen.set(false);
  }

  protected onBackdrop(event: MouseEvent): void {
    if (isBackdropClick(event)) this.close();
  }
}

@Component({
  selector: 'div[appCloseDocumentModal]',
  template: `
    <div class="modal-box remove-field-modal-box" role="dialog" aria-modal="true" aria-labelledby="closeDocumentModalTitle">
      <div class="modal-header">
        <h3 id="closeDocumentModalTitle">Close Document</h3>
        <button type="button" class="modal-close" id="closeCloseDocumentModalBtn" aria-label="Close" (click)="close()">
          <span class="icon icon-close" aria-hidden="true"></span>
        </button>
      </div>
      <div class="remove-field-body">
        <img class="remove-field-seal" src="/assets/images/seal-curious.webp" alt="" aria-hidden="true" />
        <div class="remove-field-text">
          <p class="modal-hint remove-field-hint">Nothing is saved on a server — all changes will be lost.</p>
        </div>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" id="cancelCloseDocumentBtn" (click)="close()">Cancel</button>
        <button type="button" class="btn btn-danger" id="confirmCloseDocumentBtn" (click)="confirm()">Close Document</button>
      </div>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    id: 'closeDocumentModal',
    class: 'modal-backdrop',
    '[class.is-open]': 'ui.closeDocumentModalOpen()',
    '[attr.aria-hidden]': '!ui.closeDocumentModalOpen()',
    '(click)': 'onBackdrop($event)',
  },
})
export class CloseDocumentModal {
  protected readonly ui = inject(UiService);
  private readonly documents = inject(DocumentService);

  protected close(): void {
    this.ui.closeDocumentModalOpen.set(false);
  }

  protected confirm(): void {
    this.close();
    this.documents.closeActiveDocument();
  }

  protected onBackdrop(event: MouseEvent): void {
    if (isBackdropClick(event)) this.close();
  }
}

@Component({
  selector: 'div[appRemoveFieldModal]',
  template: `
    <div class="modal-box remove-field-modal-box" role="dialog" aria-modal="true" aria-labelledby="removeFieldModalTitle">
      <div class="modal-header">
        <h3 id="removeFieldModalTitle">Remove Field</h3>
        <button type="button" class="modal-close" id="closeRemoveFieldModalBtn" aria-label="Close" (click)="close()">
          <span class="icon icon-close" aria-hidden="true"></span>
        </button>
      </div>
      <div class="remove-field-body">
        <img class="remove-field-seal" src="/assets/images/seal-curious.webp" alt="" aria-hidden="true" />
        <div class="remove-field-text">
          <p class="modal-hint remove-field-hint">
            Remove the field <strong id="removeFieldModalName">{{ ui.removeFieldName() }}</strong> from this document?
          </p>
          <p class="modal-hint remove-field-hint">This is staged like any other change — you can still <strong>Discard</strong> it before hitting Apply.</p>
        </div>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" id="cancelRemoveFieldBtn" (click)="close()">Cancel</button>
        <button type="button" class="btn btn-danger" id="confirmRemoveFieldBtn" (click)="confirm()">Remove Field</button>
      </div>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    id: 'removeFieldModal',
    class: 'modal-backdrop',
    '[class.is-open]': 'ui.removeFieldName() !== null',
    '(click)': 'onBackdrop($event)',
  },
})
export class RemoveFieldModal {
  protected readonly ui = inject(UiService);
  private readonly signatures = inject(SignaturesStore);

  protected close(): void {
    this.ui.removeFieldName.set(null);
  }

  protected confirm(): void {
    const name = this.ui.removeFieldName();
    this.close();
    if (name) this.signatures.removeFieldByName(name);
  }

  protected onBackdrop(event: MouseEvent): void {
    if (isBackdropClick(event)) this.close();
  }
}

@Component({
  selector: 'div[appDemoReplaceModal]',
  template: `
    <div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="demoReplaceModalTitle">
      <div class="modal-header">
        <h3 id="demoReplaceModalTitle">Replace the open document?</h3>
        <button type="button" class="modal-close" id="closeDemoReplaceModalBtn" aria-label="Close" (click)="tour.cancelDemoReplace()">
          <span class="icon icon-close" aria-hidden="true"></span>
        </button>
      </div>
      <p class="modal-hint">
        Loading the sample document replaces the PDF you have open now, and clears its version history from this browser (version history
        lives only locally, never on the server).
      </p>
      <p class="modal-hint" id="demoReplaceUnappliedNote" [hidden]="signatures.pendingCount() === 0">
        You also have unapplied field changes on the current document — those will be lost too.
      </p>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" id="cancelDemoReplaceBtn" (click)="tour.cancelDemoReplace()">Cancel</button>
        <button type="button" class="btn btn-primary" id="confirmDemoReplaceBtn" (click)="tour.confirmDemoReplace()">Replace document</button>
      </div>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    id: 'demoReplaceModal',
    class: 'modal-backdrop',
    '[class.is-open]': 'tour.demoReplacePending() !== null',
    '[attr.aria-hidden]': 'tour.demoReplacePending() === null',
    '(click)': 'onBackdrop($event)',
  },
})
export class DemoReplaceModal {
  protected readonly tour = inject(TourService);
  protected readonly signatures = inject(SignaturesStore);

  protected onBackdrop(event: MouseEvent): void {
    if (isBackdropClick(event)) this.tour.cancelDemoReplace();
  }
}

@Component({
  selector: 'div[appXmpRawModal]',
  template: `
    <div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="xmpRawModalTitle">
      <div class="modal-header">
        <h3 id="xmpRawModalTitle">Raw XMP metadata</h3>
        <button type="button" class="modal-close" id="closeXmpRawModalBtn" aria-label="Close" (click)="ui.xmpRaw.set(null)">
          <span class="icon icon-close" aria-hidden="true"></span>
        </button>
      </div>
      <pre class="xmp-raw-body" id="xmpRawBody">{{ ui.xmpRaw() }}</pre>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    id: 'xmpRawModal',
    class: 'modal-backdrop',
    '[class.is-open]': 'ui.xmpRaw() !== null',
    '[attr.aria-hidden]': 'ui.xmpRaw() === null',
    '(click)': 'onBackdrop($event)',
  },
})
export class XmpRawModal {
  protected readonly ui = inject(UiService);

  protected onBackdrop(event: MouseEvent): void {
    if (isBackdropClick(event)) this.ui.xmpRaw.set(null);
  }
}

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
