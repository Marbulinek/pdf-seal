import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { noPreviewReasonText } from '../../features/versions/versions-model';
import { VersionsStore } from '../../features/versions/versions.store';
import { DictionaryChanges, ObjectBadges, StreamDiff } from '../../shared/diff-bits';
import { MetaTree } from '../../shared/meta-tree';
import { isBackdropClick } from './simple-modals';

/**
 * Raw PDF object inspector -- the destination of every Details-tab chip's
 * "PDF source" button. Always has something to show: where the object is (or
 * why it isn't anywhere), its changed keys, its full before/after source, and
 * its content-stream diff.
 */
@Component({
  selector: 'div[appRawObjectModal]',
  imports: [MetaTree, DictionaryChanges, StreamDiff, ObjectBadges],
  template: `
    @let entry = versions.rawModal();
    <div class="modal-box raw-object-modal-box" role="dialog" aria-modal="true" aria-labelledby="rawObjectModalTitle">
      <div class="modal-header">
        <div class="raw-object-modal-heading">
          <h3 id="rawObjectModalTitle">{{ entry ? entry.item.label || entry.item.key + ' — ' + (entry.item.humanName || 'Object') : 'Object' }}</h3>
          <div class="diff-object-badges" id="rawObjectModalBadges">
            @if (entry) {
              <app-object-badges [item]="entry.item" [withCategory]="true" invisibleTitle="This field's /Rect is at or near zero size, so it has no visible footprint on the page." />
            }
          </div>
        </div>
        <button type="button" class="modal-close" id="closeRawObjectModalBtn" aria-label="Close" (click)="versions.closeRawObject()">
          <span class="icon icon-close" aria-hidden="true"></span>
        </button>
      </div>
      @if (entry) {
        <div class="raw-object-modal-body">
          <div class="raw-object-modal-section">
            <h4 class="diff-section-title">
              <span class="diff-section-icon"><span class="icon icon-eye" aria-hidden="true"></span></span>Location
            </h4>
            <div class="raw-object-where" id="rawObjectModalWhere">
              @if (entry.item.previewMode !== 'none') {
                <button type="button" class="btn btn-primary btn-sm" id="rawObjectModalShowBtn" (click)="showOnPage()">{{ showLabel() }}</button>
                @if (entry.item.previewMode === 'visual-page') {
                  <p class="raw-object-where-note">
                    This draws every visible change on the page — from this content stream and any annotations on it, not just this object alone.
                  </p>
                }
              } @else {
                <p class="raw-object-where-note">{{ noPreviewText() }}</p>
              }
            </div>
          </div>
          <div class="raw-object-modal-section" id="rawObjectModalChangedKeys">
            @if (entry.item.dictionaryChanges.length) {
              <app-dictionary-changes [changes]="entry.item.dictionaryChanges" [withExplainers]="true" />
            } @else {
              <p class="diff-empty-note">No dictionary key changes.</p>
            }
          </div>
          <div class="raw-object-modal-section raw-object-source">
            <div class="raw-object-source-header">
              <h4 class="diff-section-title">
                <span class="diff-section-icon"><span class="icon icon-code" aria-hidden="true"></span></span>PDF source
              </h4>
              <input
                #search
                type="text"
                class="meta-search-input"
                id="rawObjectSourceSearch"
                placeholder="Find a key or value…"
                [value]="versions.rawSourceTerm()"
                (input)="versions.setRawSourceTerm(search.value)"
              />
            </div>
            <div class="raw-object-source-columns">
              <div class="raw-object-source-col raw-object-source-col-before">
                <div class="raw-object-source-col-title">Before</div>
                <div id="rawObjectSourceBefore"><app-meta-tree [node]="entry.item.sourceBefore" [term]="versions.rawSourceTerm()" /></div>
              </div>
              <div class="raw-object-source-col raw-object-source-col-after">
                <div class="raw-object-source-col-title">After</div>
                <div id="rawObjectSourceAfter"><app-meta-tree [node]="entry.item.sourceAfter" [term]="versions.rawSourceTerm()" /></div>
              </div>
            </div>
            <p class="diff-truncated-note" id="rawObjectSourceTruncatedNote" [hidden]="!entry.item.sourceTruncated">
              Some keys/entries were omitted from this view to keep it readable.
            </p>
          </div>
          <div class="raw-object-modal-section" id="rawObjectModalStreamDiff"><app-stream-diff [diff]="entry.item.streamDiff" /></div>
          <div class="raw-object-modal-section" id="rawObjectModalIntegrity">
            @if (integrityIssues().length) {
              <div class="diff-object-subsection">
                <div class="diff-object-subsection-title">Integrity</div>
                <ul class="diff-list">
                  @for (msg of integrityIssues(); track $index) {
                    <li class="diff-row"><span class="diff-row-badge badge-removed">issue</span><span class="diff-row-values">{{ msg }}</span></li>
                  }
                </ul>
              </div>
            }
          </div>
        </div>
      }
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    id: 'rawObjectModal',
    class: 'modal-backdrop',
    '[class.is-open]': '!!versions.rawModal()',
    '[attr.aria-hidden]': '!versions.rawModal()',
    '(click)': 'onBackdrop($event)',
  },
})
export class RawObjectModal {
  protected readonly versions = inject(VersionsStore);

  protected readonly showLabel = computed(() => {
    const item = this.versions.rawModal()?.item;
    if (!item) return '';
    const page = item.page !== null && Number.isInteger(item.page) ? item.page + 1 : null;
    return item.previewMode === 'visual-page' ? `Show page ${page} changes` : `Show on page ${page}`;
  });

  protected readonly noPreviewText = computed(() => {
    const item = this.versions.rawModal()?.item;
    return item ? noPreviewReasonText(item) : '';
  });

  protected readonly integrityIssues = computed(() => {
    const key = this.versions.rawModal()?.item.key;
    if (!key) return [];
    return (this.versions.diff()?.integrity?.issues ?? []).filter((msg) => msg.startsWith(`${key} `));
  });

  protected showOnPage(): void {
    const entry = this.versions.rawModal();
    this.versions.closeRawObject();
    if (entry) this.versions.toggleChipPreview(entry.objectId, entry.item, entry.side);
  }

  protected onBackdrop(event: MouseEvent): void {
    if (isBackdropClick(event)) this.versions.closeRawObject();
  }
}
