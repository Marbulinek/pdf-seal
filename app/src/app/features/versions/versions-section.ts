import { DOCUMENT } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import type { VersionBadge } from '../../core/version-history';
import { DocumentStore } from '../../core/document.store';
import { OvFacts } from '../../shared/ov-facts';
import { OvHero, type HeroModel } from '../../shared/ov-hero';
import { RevisionCard } from './revision-card';
import { TAG_LABEL_CLASS, TAG_LABEL_DESCRIPTION, revisionLabel } from './versions-model';
import { VersionsStore, type CardModel } from './versions.store';

/**
 * Versions: every save this browser stored for the document, oldest first,
 * as a timeline of cards (grouped by save kind, stacked when saved in the
 * same minute), plus the way into the Compare sheet.
 */
@Component({
  selector: 'section[appVersionsSection]',
  imports: [OvHero, OvFacts, RevisionCard],
  templateUrl: './versions-section.html',
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
