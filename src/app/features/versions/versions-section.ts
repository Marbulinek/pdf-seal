import { DOCUMENT } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import type { VersionBadge } from '../../../../lib/VersionHistory';
import { DocumentStore } from '../../core/document.store';
import { OvFacts, OvHero, type HeroModel } from '../../shared/ov-ui';
import { TAG_LABEL_CLASS, TAG_LABEL_DESCRIPTION, revisionLabel } from './versions-model';
import { VersionsStore, type CardModel } from './versions.store';

/** One version card on the timeline (also used inside a stack). */
@Component({
  selector: 'li[appRevisionCard]',
  imports: [OvFacts],
  template: `
    @let c = card();
    <button
      type="button"
      class="revision-card-head"
      [attr.data-rev-toggle]="c.rev.index"
      aria-label="Toggle revision details"
      [attr.aria-expanded]="c.expanded"
      (click)="toggleCard($event, c.rev.index)"
    >
      <div class="revision-card-head-top">
        <div class="revision-card-title">
          <span class="revision-index-badge" [title]="'Version ' + c.rev.index">{{ c.rev.index }}</span>
          <span>{{ label(c.rev) }}</span>
        </div>
        <span class="revision-expand-btn" aria-hidden="true"><span class="icon {{ c.expanded ? 'icon-chevron-down' : 'icon-chevron-right' }}" aria-hidden="true"></span></span>
      </div>
      @if (c.badges.length) {
        <div class="revision-row-tags">
          @for (badge of c.badges; track badge.label) {
            <span class="revision-tag {{ tagClass(badge) }}" [title]="tagTitle(badge)">{{ badge.label }}</span>
          }
        </div>
      }
    </button>
    <div class="revision-card-body">
      @if (!c.rev.loaded) {
        <p class="field-details-empty revision-details-placeholder">
          {{
            c.rev.detailState === 'loading'
              ? 'Loading revision details…'
              : c.rev.detailState
                ? c.rev.detailState
                : "Expand to load this revision's details."
          }}
        </p>
      } @else {
        <app-ov-facts [facts]="c.facts" />
        @if (c.signed) {
          <div class="revision-card-signatures">
            <span class="icon icon-lock" aria-hidden="true"></span>
            {{ signatureNames(c) }}
          </div>
        }
        @if (c.modified) {
          <div class="revision-row-sub">modified {{ c.modified }}</div>
        }
        @if (c.rev.parseError) {
          <div class="revision-card-error">Could not be parsed standalone: {{ c.rev.parseError }}</div>
        }
      }
      <div class="revision-card-actions">
        <button
          type="button"
          class="btn revision-action-btn"
          title="View this revision in the document viewer"
          data-rev-action="view"
          [attr.data-rev-index]="c.rev.index"
          [class.is-active]="versions.selectedView() === c.rev.index"
          (click)="versions.viewRevision(c.rev.index)"
        >
          View
        </button>
        @if (c.prevDisplayedIndex !== null) {
          <button
            type="button"
            class="btn revision-action-btn"
            title="Visually compare this revision against the one right before it"
            data-rev-action="diff-prev"
            [attr.data-rev-index]="c.rev.index"
            [attr.data-rev-prev-index]="c.prevDisplayedIndex"
            (click)="versions.runQuickDiff(c.prevDisplayedIndex, c.rev.index, 'visual')"
          >
            <span class="icon icon-repeat" aria-hidden="true"></span> vs previous
          </button>
        }
        <span class="revision-action-divider" aria-hidden="true"></span>
        <button
          type="button"
          class="icon-btn revision-action-btn"
          title="Download this revision as a standalone PDF"
          data-rev-action="download"
          [attr.data-rev-index]="c.rev.index"
          (click)="versions.downloadRevision(c.rev.index)"
        >
          <span class="icon icon-download" aria-hidden="true"></span>
        </button>
      </div>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'revision-card',
    '[class.is-expanded]': 'card().expanded',
    '[class.is-collapsed]': '!card().expanded',
    '[class.has-error]': '!!card().rev.parseError',
    '[class.is-signed]': 'card().signed',
    '[class.is-group-end]': 'card().groupEnd',
    '[class.is-selected]': 'versions.selectedView() === card().rev.index',
  },
})
export class RevisionCard {
  readonly card = input.required<CardModel>();
  protected readonly versions = inject(VersionsStore);
  protected readonly label = revisionLabel;

  protected tagClass(badge: VersionBadge): string {
    return TAG_LABEL_CLASS[badge.label] || 'tag-original';
  }

  protected tagTitle(badge: VersionBadge): string {
    return TAG_LABEL_DESCRIPTION[badge.label] || '';
  }

  protected signatureNames(card: CardModel): string {
    return (card.rev.signatures ?? []).map((s) => s.name || s.fieldName || 'Signature').join(', ');
  }

  protected toggleCard(event: Event, index: number): void {
    event.stopPropagation();
    void this.versions.toggleCard(index);
  }
}

/**
 * Versions: every save this browser stored for the document, oldest first,
 * as a timeline of cards (grouped by save kind, stacked when saved in the
 * same minute), plus the way into the Compare sheet.
 */
@Component({
  selector: 'section[appVersionsSection]',
  imports: [OvHero, OvFacts, RevisionCard],
  template: `
    <section class="panel revisions-list-panel" id="revisionsListPanel">
      <div class="panel-overlay" id="revisionsListPanelOverlay" [class.is-hidden]="!!doc.pdfDoc()">
        <div class="panel-overlay-text">Upload a document first to see version history</div>
      </div>
      <h3><span class="panel-dot dot-ocean"></span>Version History</h3>
      <div id="revisionsHero">
        @if (hero(); as h) {
          <div class="overview-header">
            <app-ov-hero [hero]="h" />
            <app-ov-facts [facts]="versions.hero().facts" />
          </div>
        }
      </div>
      <p class="revisions-hint">
        Every saved version of this document in this browser, oldest first. <em>Incremental update</em> means the save was appended to the file
        (earlier signatures stay intact); <em>Full rewrite</em> means the file was regenerated.
      </p>

      <label class="revisions-filter-toggle" id="revisionsFilterToggleLabel" [hidden]="!showList() || !versions.filterIsMeaningful()">
        <input #onlyIncremental type="checkbox" id="chkOnlyIncrementalVersions" [checked]="versions.onlyIncremental()" (change)="versions.setOnlyIncremental(onlyIncremental.checked)" />
        Show only incremental updates
      </label>

      <div class="revisions-empty" id="revisionsEmptyState" [hidden]="!!doc.activeFile()">
        <p>Upload a PDF using the <strong>Upload</strong> button above to see its version history.</p>
      </div>
      <div class="revisions-loading" id="revisionsLoadingState" [hidden]="!versions.loading()">
        <span class="spinner" aria-hidden="true"></span> Reading version history…
      </div>
      <div class="revisions-empty" id="revisionsErrorState" [hidden]="!versions.error()">{{ versions.error() }}</div>
      <p class="revisions-hint revisions-filter-note" id="revisionsFilterNote" [hidden]="!showList() || !versions.filterNoteVisible()">
        No incremental updates — every save rewrote the file.
      </p>

      <ul class="revisions-timeline" id="revisionsTimeline" [hidden]="!showList()">
        @for (node of versions.timeline(); track $index) {
          @switch (node.kind) {
            @case ('divider') {
              <li class="revision-group-divider is-{{ node.divider.kind }}"><span class="revision-group-divider-label">{{ node.divider.label }}</span></li>
            }
            @case ('stack') {
              <li class="revision-stack" [class.is-open]="node.open" [class.is-signed]="node.signed" [class.is-current]="node.current" [class.is-group-end]="node.groupEnd">
                <button
                  type="button"
                  class="revision-stack-head"
                  [attr.data-stack-toggle]="node.firstIndex"
                  [attr.aria-label]="'Toggle versions ' + node.range"
                  [attr.aria-expanded]="node.open"
                  (click)="toggleStack(node.firstIndex, node.members, node.open)"
                >
                  <div class="revision-card-head-top">
                    <div class="revision-card-title">
                      <span class="revision-index-badge is-range" [title]="'Versions ' + node.range">{{ node.range }}</span>
                      <span>Versions {{ node.range }}</span>
                      <span class="revision-stack-count">{{ node.members.length }} saves</span>
                    </div>
                    <span class="revision-expand-btn" aria-hidden="true"><span class="icon {{ node.open ? 'icon-chevron-down' : 'icon-chevron-right' }}" aria-hidden="true"></span></span>
                  </div>
                  <div class="revision-row-sub">modified {{ node.modified }}</div>
                  @if (node.badges.length) {
                    <div class="revision-row-tags">
                      @for (badge of node.badges; track badge.label) {
                        <span class="revision-tag {{ tagClass(badge) }}" [title]="tagTitle(badge)">{{ badge.label }}</span>
                      }
                    </div>
                  }
                </button>
                <ul class="revision-stack-items">
                  @for (card of node.members; track card.rev.index) {
                    <li appRevisionCard [card]="card"></li>
                  }
                </ul>
              </li>
            }
            @case ('card') {
              <li appRevisionCard [card]="node.card"></li>
            }
          }
        }
      </ul>
    </section>

    <section class="panel revisions-diff-panel" id="revisionsDiffPanel" [hidden]="!compareAvailable()">
      <div class="panel-overlay" id="revisionsDiffPanelOverlay" [class.is-hidden]="!!doc.pdfDoc()">
        <div class="panel-overlay-text">Upload a document first to compare versions</div>
      </div>
      <h3><span class="panel-dot dot-coral"></span>Compare Versions</h3>
      <p class="revisions-hint">
        Pick any two versions and see exactly what changed between them — an overview of what moved, the details behind it, and the changed passages
        marked on the page itself.
      </p>
      <button type="button" class="btn btn-primary btn-block" id="btnOpenCompare" [hidden]="!compareAvailable()" (click)="openCompare()">
        <span class="icon icon-layers" aria-hidden="true"></span> Compare versions…
      </button>
    </section>

  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    id: 'sectionRevisions',
    class: 'section-panel revisions-section-panel active section-panel-enter',
    'data-section-panel': 'revisions',
  },
})
export class VersionsSection {
  protected readonly doc = inject(DocumentStore);
  protected readonly versions = inject(VersionsStore);
  private readonly document = inject(DOCUMENT);

  protected readonly label = revisionLabel;

  protected readonly showList = computed(
    () => !!this.doc.activeFile() && !!this.versions.revisions() && !this.versions.loading() && !this.versions.error(),
  );
  protected readonly compareAvailable = computed(() => this.showList() && this.versions.canCompare());

  protected readonly hero = computed<HeroModel | null>(() => {
    if (!this.showList()) return null;
    const h = this.versions.hero();
    return {
      kind: 'versions',
      icon: 'icon-clock',
      label: h.label,
      subtitle: h.subtitle,
      badge: h.signed ? { type: 'pill', text: 'Signed', tone: 'positive' } : null,
    };
  });

  protected tagClass(badge: VersionBadge): string {
    return TAG_LABEL_CLASS[badge.label] || 'tag-original';
  }

  protected tagTitle(badge: VersionBadge): string {
    return TAG_LABEL_DESCRIPTION[badge.label] || '';
  }

  protected toggleStack(firstIndex: number, members: CardModel[], open: boolean): void {
    this.versions.toggleStack(
      firstIndex,
      members.map((m) => m.rev.index),
      open,
    );
  }

  protected openCompare(): void {
    this.versions.openCompareSheet();
    this.document.getElementById('revisionFromSelect')?.focus();
  }
}
