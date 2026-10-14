import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { noPreviewReasonText } from '../../features/versions/versions-model';
import { VersionsStore } from '../../features/versions/versions.store';
import { DictionaryChanges } from '../../shared/dictionary-changes';
import { MetaTree } from '../../shared/meta-tree';
import { ObjectBadges } from '../../shared/object-badges';
import { StreamDiff } from '../../shared/stream-diff';
import { isBackdropClick } from './backdrop-click';

/**
 * Raw PDF object inspector -- the destination of every Details-tab chip's
 * "PDF source" button. Always has something to show: where the object is (or
 * why it isn't anywhere), its changed keys, its full before/after source, and
 * its content-stream diff.
 */
@Component({
  selector: 'div[appRawObjectModal]',
  imports: [MetaTree, DictionaryChanges, StreamDiff, ObjectBadges],
  templateUrl: './raw-object-modal.html',
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
