import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { UiService } from '../../core/ui.service';
import { TourService } from '../../features/tour/tour.service';
import { isBackdropClick } from './simple-modals';

interface HelpTopic {
  title: string;
  /** Tour chapter for the "Show me" button; topics without one have no button. */
  chapter: string | null;
  paragraphs: string[];
}

const TOPICS: HelpTopic[] = [
  {
    title: 'Getting started',
    chapter: 'intro',
    paragraphs: [
      'Upload a PDF (drag & drop, the Upload button, or Base64), then use the page/zoom/pan controls and the section tabs — Overview, Signatures, Versions, Certificates — to move between features.',
    ],
  },
  {
    title: 'Signatures',
    chapter: 'signatures',
    paragraphs: [
      'Add signature fields by placing them on the page, then drag to move or use the grip to resize. Selecting a field opens its edit panel; new and edited fields stage as pending changes until you Apply or Discard them, and every staged change can be undone/redone with the history buttons.',
    ],
  },
  {
    title: 'Signature templates',
    chapter: 'templates',
    paragraphs: [
      "Turn on templates in Settings to save a placed field's layout for reuse. Capture a field into a template, then place its items back manually or automatically onto any document. Back up or restore your templates as a JSON file in Settings.",
    ],
  },
  {
    title: 'Overview',
    chapter: 'metadata',
    paragraphs: [
      'The Overview section summarizes the document — title, author, pages, whether it is signed — and lists everything on it: signatures, stamps, form fields, links and comments. While it is open, those objects are outlined on the page; click one (or its row in the list) to see its details. Overview is read-only. Turn on "Show advanced PDF raw data" in Settings to see raw PDF objects in the Signatures, Versions and Certificates panels.',
    ],
  },
  {
    title: 'Versions & compare',
    chapter: 'revisions',
    paragraphs: [
      'Every save is tracked as a version, stored locally in your browser, and badged by how it was produced — an incremental update (appended, earlier signatures stay intact) or a full rewrite. Pick two versions to compare: an overview of what changed, a detailed field-by-field breakdown, and a visual diff highlighting the changed regions on the page.',
    ],
  },
];

const TAIL_TOPICS: HelpTopic[] = [
  {
    title: 'Share & export',
    chapter: 'finish',
    paragraphs: [
      'Download the document, copy it as Base64, or share it peer-to-peer: a private link that transfers the encrypted PDF directly between browsers, verified by the recipient. Share sessions expire automatically after 15 minutes.',
    ],
  },
  {
    title: 'Settings',
    chapter: 'settings',
    paragraphs: [
      'Settings turns optional panels on and off — signature templates, raw PDF data, version bundling on export, and the certificate scratchpad/trust simulation/modification tools — and holds the template backup/restore buttons.',
    ],
  },
  {
    title: 'Privacy',
    chapter: null,
    paragraphs: [
      'Field edits, metadata changes, and version history live in this browser (IndexedDB/localStorage) until you export or apply changes, which sends the current document to the server to be modified and immediately deleted afterward. Peer-to-peer shares never touch the server except to exchange connection info — the PDF itself travels encrypted, browser to browser.',
    ],
  },
];

/** Help topics plus the entry points into the interactive tour. */
@Component({
  selector: 'div[appHelpModal]',
  template: `
    <div class="modal-box help-modal-box" role="dialog" aria-modal="true" aria-labelledby="helpModalTitle">
      <div class="modal-header">
        <h3 id="helpModalTitle">Help &amp; interactive demo</h3>
        <button type="button" class="modal-close" id="closeHelpModalBtn" aria-label="Close" (click)="close()">
          <span class="icon icon-close" aria-hidden="true"></span>
        </button>
      </div>

      <div class="help-hero-panel">
        <img class="help-hero-seal" src="/assets/images/seal-curious.webp" alt="" aria-hidden="true" />
        <div class="help-hero-copy">
          <p class="modal-hint">
            New here? Load the bundled sample agreement and see every feature in action, guided step by step — or just poke around on your own.
          </p>
          <div class="help-hero-actions">
            <button type="button" class="btn btn-primary" id="btnStartTour" (click)="showMe($event, 'intro')">Start interactive tour</button>
            <button type="button" class="btn btn-ghost" id="btnLoadSampleOnly" (click)="loadSampleOnly()">Just load the sample</button>
          </div>
        </div>
      </div>

      <div class="help-topics">
        @for (topic of topics; track topic.title) {
          <details class="help-topic">
            <summary>
              <span class="help-topic-title">{{ topic.title }}</span>
              @if (topic.chapter) {
                <button type="button" class="btn btn-ghost btn-small help-show-me" [attr.data-tour-chapter]="topic.chapter" (click)="showMe($event, topic.chapter)">
                  Show me
                </button>
              }
            </summary>
            <div class="help-topic-body">
              @for (p of topic.paragraphs; track $index) {
                <p>{{ p }}</p>
              }
            </div>
          </details>
        }
        <details class="help-topic">
          <summary>
            <span class="help-topic-title">Certificates</span>
            <button type="button" class="btn btn-ghost btn-small help-show-me" data-tour-chapter="certificates" (click)="showMe($event, 'certificates')">
              Show me
            </button>
          </summary>
          <div class="help-topic-body">
            <p>
              The Certificates section reports on any signatures found in the document: integrity, the certificate chain behind each one, and
              whether required fields are still waiting to be signed. Optional tools (enabled in Settings) add a standalone certificate scratchpad,
              a trust simulation against a root CA bundle you supply, and certificate modification for building test documents.
            </p>
            <p><a href="/assets/demo/pdf-seal-demo-root-ca.pem" download>Download the demo root CA</a> to try trust simulation against the sample document.</p>
          </div>
        </details>
        @for (topic of tailTopics; track topic.title) {
          <details class="help-topic">
            <summary>
              <span class="help-topic-title">{{ topic.title }}</span>
              @if (topic.chapter) {
                <button type="button" class="btn btn-ghost btn-small help-show-me" [attr.data-tour-chapter]="topic.chapter" (click)="showMe($event, topic.chapter)">
                  Show me
                </button>
              }
            </summary>
            <div class="help-topic-body">
              @for (p of topic.paragraphs; track $index) {
                <p>{{ p }}</p>
              }
            </div>
          </details>
        }
        <details class="help-topic">
          <summary><span class="help-topic-title">Keyboard shortcuts</span></summary>
          <div class="help-topic-body">
            <p><kbd>Esc</kbd> closes the open modal, sheet, or tour. Inside the tour, <kbd>←</kbd>/<kbd>→</kbd> step back and forward.</p>
          </div>
        </details>
      </div>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    id: 'helpModal',
    class: 'modal-backdrop',
    '[class.is-open]': 'ui.helpModalOpen()',
    '[attr.aria-hidden]': '!ui.helpModalOpen()',
    '(click)': 'onBackdrop($event)',
  },
})
export class HelpModal {
  protected readonly ui = inject(UiService);
  private readonly tour = inject(TourService);
  protected readonly topics = TOPICS;
  protected readonly tailTopics = TAIL_TOPICS;

  protected close(): void {
    this.ui.helpModalOpen.set(false);
  }

  protected onBackdrop(event: MouseEvent): void {
    if (isBackdropClick(event)) this.close();
  }

  protected showMe(event: Event, chapter: string): void {
    // The "Show me" buttons sit inside <summary>: don't toggle the topic.
    event.preventDefault();
    event.stopPropagation();
    this.close();
    this.tour.start(chapter);
  }

  protected loadSampleOnly(): void {
    this.close();
    this.tour.requestDemoSampleLoad(null);
  }
}
