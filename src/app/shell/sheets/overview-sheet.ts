import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, untracked } from '@angular/core';
import { DocumentStore } from '../../core/document.store';
import { UiService } from '../../core/ui.service';
import { CertificatesStore } from '../../features/certificates/certificates.store';
import { overviewActionLabel, overviewSheetModel, type OverviewAction } from '../../features/overview/overview-model';
import { OverviewStore } from '../../features/overview/overview.store';
import { AppendNode } from '../../shared/append-node';
import { Evidence, OvFacts, OvFlags, OvHero, OvSectionTitle } from '../../shared/ov-ui';

/** One object from the Overview list (signature, stamp, field, link, comment). */
@Component({
  selector: 'aside[appOverviewSheet]',
  imports: [OvHero, OvFacts, OvFlags, OvSectionTitle, Evidence, AppendNode],
  template: `
    @let m = model();
    <div class="edit-sheet-header">
      <span class="edit-sheet-grabber" aria-hidden="true"></span>
      <span class="panel-dot dot-ocean"></span>
      <h3 id="overviewSheetTitle">
        @if (m) {
          <span class="icon {{ m.icon }}" aria-hidden="true"></span> {{ m.title }}
        } @else {
          Details
        }
      </h3>
      <span class="edit-sheet-subject" id="overviewSheetSubject">{{ m?.subject }}</span>
      <button type="button" class="modal-close" id="btnOverviewSheetClose" aria-label="Close details" (click)="overview.closeSheet()">
        <span class="icon icon-close" aria-hidden="true"></span>
      </button>
    </div>
    <div class="edit-sheet-body" id="overviewSheetBody">
      @if (m) {
        <app-ov-hero [hero]="m.hero" />
        @if (m.placement.hasRect) {
          <div class="ov-snippet" data-ov-snippet>
            @if (visuals(); as v) {
              @if (v.snippet) {
                <div class="ov-snippet-frame" [appAppendNode]="v.snippet">
                  @if (v.mark; as mark) {
                    <span class="ov-snippet-mark" [style.left]="mark.left" [style.top]="mark.top" [style.width]="mark.width" [style.height]="mark.height"></span>
                  }
                </div>
              } @else if (v.note) {
                <p class="ov-snippet-note">{{ v.note }}</p>
              }
            } @else if (overview.visualsPending()) {
              <span class="ov-snippet-loading">Rendering preview…</span>
            }
          </div>
        }
        <div class="ov-placement">
          @if (m.placement.hasRect) {
            <div class="ov-pagemap" data-ov-pagemap aria-hidden="true">
              @if (visuals(); as v) {
                <div class="ov-pagemap-page" [style.aspect-ratio]="v.map.aspect">
                  <span class="ov-pagemap-mark" [style.left]="v.map.left" [style.top]="v.map.top" [style.width]="v.map.width" [style.height]="v.map.height"></span>
                </div>
              }
            </div>
          }
          <div class="ov-placement-text" [attr.title]="m.placement.title">
            @for (line of m.placement.lines; track $index; let first = $first) {
              <span [class.ov-placement-page]="first">{{ line }}</span>
            }
          </div>
        </div>
        @if (m.quote) {
          <blockquote class="ov-quote">{{ m.quote }}</blockquote>
        }
        @if (m.url; as url) {
          <div class="overview-url">
            @if (url.host) {
              <span class="overview-url-host">{{ url.host }}</span>
            }
            <span class="overview-url-full">{{ url.full }}</span>
          </div>
        }
        <app-ov-facts [facts]="m.facts" />
        @if (m.flags) {
          <app-ov-flags [flags]="m.flags" />
        }
        @if (m.emptyNote) {
          <p class="field-details-empty">{{ m.emptyNote }}</p>
        }
        @if (m.evidence) {
          <app-ov-section-title icon="icon-shield" title="Signature evidence" />
          <app-evidence [rows]="m.evidence" [nativeChain]="overview.nativeChain()" (compare)="overview.openVersionsDiff($event.from, $event.to, 'overview', null)" />
        }
        @if (m.tech.length) {
          <details class="overview-tech">
            <summary><span class="icon icon-code" aria-hidden="true"></span> Technical details <span class="overview-count">{{ m.tech.length }}</span></summary>
            <dl class="ov-tech">
              @for (r of m.tech; track r.key) {
                <div class="ov-tech-row">
                  <dt>
                    {{ r.label }}
                    @if (r.key !== 'ref') {
                      <code class="ov-tech-key">/{{ r.key }}</code>
                    }
                  </dt>
                  <dd>{{ r.value }}</dd>
                </div>
              }
            </dl>
          </details>
        }
      }
    </div>
    <div class="edit-sheet-footer" id="overviewSheetFooter" [hidden]="!m || (!m.actions.length && !m.traceable)">
      @if (m) {
        @if (m.traceable) {
          <div class="overview-history" data-ov-history [attr.data-kind]="overview.activeItem()?.kind" [attr.data-key]="overview.activeItem()?.key">
            @if (overview.history(); as h) {
              @if (h.loading) {
                <p class="field-details-empty">{{ h.line }}</p>
              } @else {
                <p class="overview-callout">{{ h.line }}</p>
                @if (h.compare; as c) {
                  <button
                    type="button"
                    class="btn btn-ghost btn-small"
                    data-evidence-action="compare-versions"
                    (click)="overview.openVersionsDiff(c.from, c.to, 'details', c.term)"
                  >
                    Compare {{ c.from }} → {{ c.to }}
                  </button>
                }
              }
            }
          </div>
        }
        @for (action of m.actions; track $index) {
          @let a = actionLabel(action);
          <button type="button" class="btn" [class.btn-primary]="a.primary" [class.btn-ghost]="!a.primary" [attr.data-ov-action]="action.kind" (click)="run(action)">
            @if (a.icon) {
              <span class="icon {{ a.icon }}" aria-hidden="true"></span>
            }
            {{ a.label }}
          </button>
        }
        @if (m.traceable) {
          <button type="button" class="btn btn-ghost" data-evidence-action="find-history" (click)="overview.findElementHistory()">
            <span class="icon icon-clock" aria-hidden="true"></span> Find in version history
          </button>
        }
      }
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    id: 'overviewSheet',
    class: 'edit-sheet',
    tabindex: '-1',
    'aria-labelledby': 'overviewSheetTitle',
    '[class.is-open]': 'ui.sheets.overview()',
    '[attr.aria-hidden]': '!ui.sheets.overview()',
  },
})
export class OverviewSheet {
  protected readonly ui = inject(UiService);
  protected readonly overview = inject(OverviewStore);
  private readonly certificates = inject(CertificatesStore);
  private readonly doc = inject(DocumentStore);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected readonly actionLabel = overviewActionLabel;

  protected readonly model = computed(() => {
    const item = this.overview.activeOverviewItem();
    return item ? overviewSheetModel(item, this.certificates.reportForActiveFile(), this.overview.sheetSettled()) : null;
  });

  /** Only the visuals drawn for this very item and file. */
  protected readonly visuals = computed(() => {
    const v = this.overview.visuals();
    const item = this.overview.activeItem();
    if (!v || !item || v.id !== `${item.kind}\u0000${item.key}` || v.file !== this.doc.activeFile()) return null;
    return v;
  });

  constructor() {
    effect(() => {
      const ref = this.overview.activeItem();
      if (ref && this.ui.sheets.overview()) untracked(() => this.host.nativeElement.focus({ preventScroll: true }));
    });
    // "Show changes after signing" is offered only for this file's native chain.
    effect(() => {
      const evidence = this.model()?.evidence;
      if (!evidence) return;
      untracked(() => evidence.forEach((r) => r.slot && this.overview.checkNativeChain(r.slot.to)));
    });
  }

  protected run(action: OverviewAction): void {
    switch (action.kind) {
      case 'open-certificates':
        this.overview.openInCertificates(action.field);
        break;
      case 'edit-signature':
        this.overview.editInSignatures(action.field);
        break;
      case 'copy':
        void this.certificates.copyText(action.text, 'Link');
        break;
      case 'goto-page':
        void this.overview.gotoPage(action.page);
        break;
    }
  }
}
