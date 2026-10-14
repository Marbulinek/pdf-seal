import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';
import type { VersionBadge } from '@shared/VersionHistory';
import { OvFacts } from '../../shared/ov-facts';
import { TAG_LABEL_CLASS, TAG_LABEL_DESCRIPTION, revisionLabel } from './versions-model';
import { VersionsStore, type CardModel } from './versions.store';

/** One version card on the timeline (also used inside a stack). */
@Component({
  selector: 'li[appRevisionCard]',
  imports: [OvFacts],
  templateUrl: './revision-card.html',
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
