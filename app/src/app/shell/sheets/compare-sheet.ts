import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, linkedSignal, viewChildren } from '@angular/core';
import { DocumentStore } from '../../core/document.store';
import { UiService } from '../../core/ui.service';
import { VISUAL_DIFF_PENS, type DiffMarkStyle, type PenColor } from '../../features/versions/visual-diff.service';
import {
  checklistItems,
  chipMatchesFilter,
  diffSections,
  objectChangeCount,
  objectChipGroups,
  rawObjectCategories,
  revisionLabel,
  type ChecklistItem,
  type DiffRow,
  type DiffTab,
  type ObjectChip,
} from '../../features/versions/versions-model';
import { VersionsStore } from '../../features/versions/versions.store';
import { DictionaryChanges } from '../../shared/dictionary-changes';
import { INVISIBLE_FIELD_TITLE, ObjectBadges } from '../../shared/object-badges';

const TABS: { id: DiffTab; elementId: string; panel: string; icon: string; label: string }[] = [
  { id: 'overview', elementId: 'tabRevOverview', panel: 'revisionsDiffOverview', icon: 'icon-list', label: 'Overview' },
  { id: 'details', elementId: 'tabRevDetails', panel: 'revisionsDiffResults', icon: 'icon-layers', label: 'Details' },
  { id: 'visual', elementId: 'tabRevVisual', panel: 'visualDiffPanel', icon: 'icon-eye', label: 'Visual' },
];

/**
 * The comparison of two stored versions: the From/To picker, then Overview
 * (verdict, checklist, integrity), Details (change lists + raw objects) and
 * Visual (page marks drawn in the main viewer).
 */
@Component({
  selector: 'aside[appCompareSheet]',
  imports: [DictionaryChanges, ObjectBadges],
  templateUrl: './compare-sheet.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    id: 'revisionsCompareSheet',
    class: 'edit-sheet',
    tabindex: '-1',
    'aria-labelledby': 'revisionsCompareSheetTitle',
    '[class.is-open]': 'ui.sheets.compare()',
    '[attr.aria-hidden]': '!ui.sheets.compare()',
  },
})
export class CompareSheet {
  protected readonly ui = inject(UiService);
  protected readonly doc = inject(DocumentStore);
  protected readonly versions = inject(VersionsStore);

  protected readonly tabs = TABS;
  protected readonly label = revisionLabel;
  protected readonly abs = Math.abs;
  protected readonly invisibleTitle = INVISIBLE_FIELD_TITLE;

  protected readonly checklist = computed(() => {
    const diff = this.versions.diff();
    return diff ? checklistItems(diff) : [];
  });
  protected readonly sections = computed(() => {
    const diff = this.versions.diff();
    return diff ? diffSections(diff) : [];
  });
  protected readonly chipGroups = computed(() => {
    const diff = this.versions.diff();
    return diff ? objectChipGroups(diff, this.versions.diffFrom(), this.versions.diffTo()) : [];
  });
  protected readonly categories = computed(() => rawObjectCategories(this.chipGroups()));
  protected readonly objectCount = computed(() => {
    const diff = this.versions.diff();
    return diff ? objectChangeCount(diff) : 0;
  });
  /** Built on the first visit to Details for each comparison, then kept. */
  protected readonly detailsRendered = linkedSignal<{ diff: unknown; tab: DiffTab }, boolean>({
    source: () => ({ diff: this.versions.diff(), tab: this.versions.activeTab() }),
    computation: (source, previous) =>
      source.tab === 'details' || (!!previous && previous.value && previous.source.diff === source.diff),
  });
  private readonly tabButtons = viewChildren<ElementRef<HTMLButtonElement>>('tabButton');
  protected readonly penCss = computed(() => VISUAL_DIFF_PENS[this.versions.visualColor()].css);

  protected onFrom(event: Event): void {
    this.versions.setCompareFrom(Number((event.target as HTMLSelectElement).value));
  }

  protected onTo(event: Event): void {
    this.versions.setCompareTo(Number((event.target as HTMLSelectElement).value));
  }

  protected setStyle(value: string): void {
    this.versions.setVisualStyle(value === 'outline' ? 'outline' : ('highlight' satisfies DiffMarkStyle));
  }

  protected setColor(value: string): void {
    const color: PenColor = value === 'pink' || value === 'green' ? value : 'yellow';
    this.versions.setVisualColor(color);
  }

  /** Left/right arrows walk the tablist. */
  protected onTabKey(event: KeyboardEvent): void {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const current = TABS.findIndex((t) => t.id === this.versions.activeTab());
    if (current === -1) return;
    event.preventDefault();
    const next = TABS[(current + (event.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
    this.tabButtons().find((b) => b.nativeElement.id === next.elementId)?.nativeElement.focus();
    this.versions.switchTab(next.id);
  }

  protected goto(item: ChecklistItem): void {
    if (item.target) void this.versions.gotoChecklistTarget(item.target);
  }

  protected locate(row: DiffRow): void {
    if (row.locate) this.versions.toggleRowLocate(row.locate.key, row.locate.page, [row.locate.rect], row.locate.side);
  }

  protected locateKey(event: Event, row: DiffRow): void {
    if (!row.locate) return;
    event.preventDefault();
    this.locate(row);
  }

  protected matches(chip: ObjectChip): boolean {
    return chipMatchesFilter(chip, this.versions.rawFilter());
  }

  protected noMatches(chips: ObjectChip[]): boolean {
    return !chips.some((c) => this.matches(c));
  }

  protected preview(event: Event, chip: ObjectChip): void {
    event.stopPropagation();
    this.versions.toggleChipPreview(chip.objectId, chip.item, chip.side);
  }

  protected source(event: Event, chip: ObjectChip): void {
    event.stopPropagation();
    this.versions.openRawObject(chip.item, chip.revisionIndex, chip.objectId, chip.side);
  }
}
