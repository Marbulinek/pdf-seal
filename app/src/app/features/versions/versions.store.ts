import { DOCUMENT } from '@angular/common';
import { computed, inject } from '@angular/core';
import { patchState, signalStore, withComputed, withHooks, withMethods, withProps, withState } from '@ngrx/signals';
import {
  batchBySize,
  filterVersions,
  versionBadges,
  versionGroupDividers,
  versionStacks,
  type ElementVersionLike,
  type VersionBadge,
  type VersionGroupDivider,
} from '@shared/VersionHistory';
import { ApiService } from '../../core/api.service';
import { DocumentStore } from '../../core/document.store';
import { errorMessage } from '../../core/document.service';
import { isRectPracticallyInvisible } from '../../core/field-rules';
import type { ErrorPayload, PdfRect, RawObjectPreview, RevisionDiff, RevisionSummary } from '../../core/models';
import { NotificationService } from '../../core/notification.service';
import { UiService } from '../../core/ui.service';
import { cssEscape, downloadBlob, waitFor } from '../../core/util/dom';
import { formatDisplayDate } from '../../core/util/format';
import { lazyInject } from '../../core/util/lazy';
import { SIGNATURES, type VersionsListSnapshot } from '../../core/ports';
import { VersionStoreService } from '../../core/version-store.service';
import { ViewerService } from '../../core/viewer.service';
import { VisualDiffService, type DiffMarkStyle, type PenColor } from './visual-diff.service';
import {
  compareVerdict,
  diffPreviewLabel,
  isSigned,
  type DiffTab,
  type RevisionEntry,
} from './versions-model';

export const ONLY_INCREMENTAL_STORAGE_KEY = 'pdfseal-only-incremental-versions';


export interface CardModel {
  rev: RevisionEntry;
  displayIndex: number;
  prevDisplayedIndex: number | null;
  badges: VersionBadge[];
  signed: boolean;
  expanded: boolean;
  groupEnd: boolean;
  modified: string | null;
  facts: { label: string; value: string }[];
}

export type TimelineNode =
  | { kind: 'divider'; divider: VersionGroupDivider }
  | { kind: 'card'; card: CardModel }
  | {
      kind: 'stack';
      firstIndex: number;
      range: string;
      members: CardModel[];
      open: boolean;
      signed: boolean;
      current: boolean;
      groupEnd: boolean;
      modified: string;
      badges: VersionBadge[];
    };

type DiffPreview =
  | { mode: 'object'; objectKey: string; pageIndex: number; pdfRects: PdfRect[]; side: 'from' | 'to' }
  | { mode: 'visual-page'; objectKey: string; pageIndex: number };

type SuspendedView =
  | { kind: 'revision'; index: number; page: number; sheetOpen: boolean }
  | { kind: 'diff'; sheetOpen: boolean; tab: DiffTab; page: number };

interface RawFilter {
  term: string;
  categories: string[];
  locatableOnly: boolean;
}

interface VersionsState {
  revisions: RevisionEntry[] | null;
  /** "<sessionId>:<activeVersionKey>" the list corresponds to. */
  loadedFor: string | null;
  loading: boolean;
  error: string | null;
  onlyIncremental: boolean;
  expanded: number[];
  expandedStacks: number[];
  /** The card whose "View" is showing in the viewer. */
  selectedView: number | null;
  // Compare picker
  compareFrom: number | null;
  compareTo: number | null;
  // Comparison result
  diff: RevisionDiff | null;
  diffFrom: number | null;
  diffTo: number | null;
  diffLoading: boolean;
  diffError: string | null;
  compareSubject: string;
  activeTab: DiffTab;
  diffPage: number;
  diffMaxPages: number;
  pendingFilterTerm: string | null;
  pendingLandingTab: DiffTab | null;
  rawFilter: RawFilter;
  /** The chip/row whose on-page preview is active. */
  hoveredKey: string | null;
  /** Which chip ("<cls>:<key>") or located row (its namespaced key) is active. */
  activeObjectId: string | null;
  chipStatus: Record<string, string>;
  rawModal: { item: RawObjectPreview; revisionIndex: number | null; objectId: string; side: 'from' | 'to' } | null;
  rawSourceTerm: string;
  visualStyle: DiffMarkStyle;
  visualColor: PenColor;
  legend: { count: number; note: string } | null;
  // Single-revision "View" mode
  revisionViewIndex: number | null;
  revisionViewPage: number;
}

function readOnlyIncremental(): boolean {
  try {
    return localStorage.getItem(ONLY_INCREMENTAL_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

const initialState: VersionsState = {
  revisions: null,
  loadedFor: null,
  loading: false,
  error: null,
  onlyIncremental: readOnlyIncremental(),
  expanded: [],
  expandedStacks: [],
  selectedView: null,
  compareFrom: null,
  compareTo: null,
  diff: null,
  diffFrom: null,
  diffTo: null,
  diffLoading: false,
  diffError: null,
  compareSubject: '',
  activeTab: 'overview',
  diffPage: 1,
  diffMaxPages: 1,
  pendingFilterTerm: null,
  pendingLandingTab: null,
  rawFilter: { term: '', categories: [], locatableOnly: false },
  hoveredKey: null,
  activeObjectId: null,
  chipStatus: {},
  rawModal: null,
  rawSourceTerm: '',
  visualStyle: 'highlight',
  visualColor: 'yellow',
  legend: null,
  revisionViewIndex: null,
  revisionViewPage: 1,
};

/**
 * The Versions section: the local version timeline (IndexedDB), the compare
 * sheet (overview / details / visual), and the read-only diff/snapshot views
 * it paints into the main viewer.
 */
export const VersionsStore = signalStore(
  { providedIn: 'root' },
  withState(initialState),
  withProps(() => ({
    _doc: inject(DocumentStore),
    _api: inject(ApiService),
    _ui: inject(UiService),
    _viewer: inject(ViewerService),
    _db: inject(VersionStoreService),
    _engine: inject(VisualDiffService),
    _notifications: inject(NotificationService),
    _document: inject(DOCUMENT),
    _signatures: lazyInject(SIGNATURES),
    /**
     * In-flight summary fetches by versionKey, so a version is never uploaded
     * twice by the card-expand and background-batch paths.
     */
    _summaryPromises: new Map<string, Promise<RevisionSummary | undefined>>(),
    _flags: {
      reloadPending: false,
      suspended: null as SuspendedView | null,
      lastPreview: null as DiffPreview | null,
    },
  })),
  withComputed((store) => {
    /**
     * The filter only means anything with a genuine mix of incremental and
     * non-incremental saves -- with one group, toggling it can't change anything.
     */
    const filterIsMeaningful = computed(() => {
      const revisions = store.revisions() ?? [];
      return revisions.some((r) => r.saveKind === 'incremental') && revisions.some((r) => r.index !== 1 && r.saveKind !== 'incremental');
    });
    const displayRevisions = computed(() => {
      const revisions = store.revisions() ?? [];
      return filterIsMeaningful() ? filterVersions(revisions, store.onlyIncremental()) : revisions;
    });
    const timeline = computed<TimelineNode[]>(() => {
      const revisions = store.revisions() ?? [];
      const display = displayRevisions();
      const expanded = new Set(store.expanded());
      const expandedStacks = new Set(store.expandedStacks());
      // Dividers over the *displayed* list, so positions match the cards.
      const dividers = new Map(versionGroupDividers(display).map((d) => [d.position, d]));
      const badgesFor = (rev: RevisionEntry) => versionBadges(rev, revisions[revisions.indexOf(rev) - 1], !!rev.isFinal);
      const modifiedLabel = (rev: RevisionEntry) =>
        rev.metadata && rev.metadata.modificationDate ? formatDisplayDate(rev.metadata.modificationDate) : null;

      const card = (rev: RevisionEntry, displayIndex: number): CardModel => {
        const cs = rev.changeSummary;
        const facts = rev.loaded
          ? [
              { label: 'Pages', value: String(cs?.pageCount ?? rev.pageCount ?? '—') },
              { label: 'Text', value: String(cs?.textCount ?? 0) },
              { label: 'Images', value: String(cs?.imageCount ?? 0) },
              { label: 'Signature fields', value: String(cs?.fieldCount ?? (rev.fields ? rev.fields.length : 0)) },
              { label: 'AcroForm', value: String(cs?.acroFormCount ?? 0) },
              { label: 'Stamps', value: String(cs?.stampCount ?? (rev.stamps ? rev.stamps.length : 0)) },
              { label: 'Metadata', value: String(cs?.metadataFieldCount ?? 0) },
              { label: 'Signature', value: String(cs?.signatureCount ?? 0) },
            ]
          : [];
        return {
          rev,
          displayIndex,
          // "vs previous" compares with the card before it in the *displayed* list.
          prevDisplayedIndex: display[displayIndex - 1]?.index ?? null,
          badges: badgesFor(rev),
          signed: isSigned(rev),
          expanded: expanded.has(rev.index),
          groupEnd: dividers.has(displayIndex + 1),
          modified: modifiedLabel(rev),
          facts,
        };
      };

      // Runs of versions sharing a displayed modification time draw as one
      // collapsible stack (never crossing a group divider).
      const stackAt = new Map(versionStacks(display, modifiedLabel, new Set(dividers.keys())).map((s) => [s.start, s]));
      const nodes: TimelineNode[] = [];
      for (let i = 0; i < display.length; i++) {
        const divider = dividers.get(i);
        if (divider) nodes.push({ kind: 'divider', divider });
        const stack = stackAt.get(i);
        if (stack) {
          const members = display.slice(stack.start, stack.end + 1).map((rev, k) => card(rev, stack.start + k));
          const first = members[0].rev;
          const last = members[members.length - 1].rev;
          const seen = new Set<string>();
          const badges = members
            .flatMap((m) => m.badges)
            .filter((b) => !seen.has(b.label) && !!seen.add(b.label));
          nodes.push({
            kind: 'stack',
            firstIndex: first.index,
            range: `${first.index}–${last.index}`,
            members,
            open: expandedStacks.has(first.index) || members.some((m) => m.expanded),
            signed: members.some((m) => m.signed),
            current: !!last.isFinal,
            groupEnd: dividers.has(stack.end + 1),
            modified: modifiedLabel(first) ?? '',
            badges,
          });
          i = stack.end;
        } else {
          nodes.push({ kind: 'card', card: card(display[i], i) });
        }
      }
      return nodes;
    });
    const hero = computed(() => {
      const revisions = store.revisions() ?? [];
      const latest = revisions[revisions.length - 1];
      const modified = latest?.metadata?.modificationDate ? formatDisplayDate(latest.metadata.modificationDate) : null;
      const count = (pred: (r: RevisionEntry) => boolean) => revisions.filter(pred).length;
      return {
        label: `${revisions.length} version${revisions.length === 1 ? '' : 's'}`,
        subtitle: [latest ? `Current: Version ${latest.index}` : null, modified ? `modified ${modified}` : null]
          .filter(Boolean)
          .join(' · '),
        signed: !!latest && isSigned(latest),
        facts: [
          { label: 'Incremental updates', value: String(count((r) => r.saveKind === 'incremental')) },
          { label: 'Full rewrites', value: String(count((r) => r.saveKind === 'rewrite')) },
          { label: 'Signed versions', value: String(count(isSigned)), wide: true },
        ],
      };
    });
    return {
      filterIsMeaningful,
      displayRevisions,
      timeline,
      hero,
      canCompare: computed(() => displayRevisions().length >= 2),
      fromOptions: computed(() => {
        const to = store.compareTo();
        return displayRevisions().filter((r) => to === null || r.index < to);
      }),
      toOptions: computed(() => {
        const from = store.compareFrom();
        return displayRevisions().filter((r) => from === null || r.index > from);
      }),
      filterNoteVisible: computed(() => filterIsMeaningful() && store.onlyIncremental() && displayRevisions().length <= 1),
      diffEmptyText: computed(() => {
        if (store.diffError()) return store.diffError();
        if (displayRevisions().length < 2 && store.revisions()) {
          return store.onlyIncremental()
            ? 'Not enough incremental updates to compare with this filter on. Turn it off to compare against a full rewrite.'
            : 'This PDF only has one revision (no incremental updates were found), so there is nothing to compare yet.';
        }
        return 'Pick two versions above and hit Compare to see what changed between them.';
      }),
      visualPageCount: computed(() => Math.max(1, store.diffMaxPages())),
    };
  }),
  withMethods((store) => {
    const doc = store._doc;
    const viewer = store._viewer;
    const engine = store._engine;
    const ui = store._ui;

    const currentSession = () => doc.documentSessionId();

    // ---------------------------------------------------------------------
    // Timeline
    // ---------------------------------------------------------------------

    function applySummaries(results: Map<string, RevisionSummary>): void {
      const revisions = store.revisions();
      if (!revisions || !results.size) return;
      patchState(store, {
        revisions: revisions.map((rev) => {
          const summary = results.get(rev.versionKey);
          return summary ? { ...rev, ...summary, index: rev.index, loaded: true, detailState: undefined } : rev;
        }),
      });
    }

    /**
     * Uploads and summarizes the not-yet-loaded revisions in `revs` (one
     * request), persists each summary into its versionMeta row, and resolves
     * versionKey -> summary. A revision already being fetched by the other path
     * is left to that in-flight promise.
     */
    async function ensureSummariesLoaded(sessionId: string, revs: { index: number; versionKey: string; loaded: boolean }[]): Promise<Map<string, RevisionSummary>> {
      const need = revs.filter((rev) => !rev.loaded);
      const out = new Map<string, RevisionSummary>();
      if (!need.length) return out;

      const fresh = need.filter((rev) => !store._summaryPromises.has(rev.versionKey));
      if (fresh.length) {
        const batchPromise = (async () => {
          const blobs = await Promise.all(fresh.map((rev) => store._db.getBlob(sessionId, rev.index)));
          const included: typeof fresh = [];
          const formData = new FormData();
          fresh.forEach((rev, i) => {
            const blob = blobs[i];
            if (blob) {
              formData.append('pdfDocument', blob, `revision-${rev.index}.pdf`);
              included.push(rev);
            }
          });
          if (!included.length) return new Map<string, RevisionSummary>();

          const res = await store._api.postForm('/api/revisions', formData);
          let data: { revisions?: (RevisionSummary & { index?: number; isFinal?: boolean })[] } & ErrorPayload;
          try {
            data = await res.json();
          } catch {
            throw new Error(`Server returned status ${res.status}.`);
          }
          if (!res.ok) throw new Error(data?.error || 'Could not read these revisions.');

          // The server's batch-local index/isFinal mean nothing here -- drop them.
          const rawRevisions = Array.isArray(data.revisions) ? data.revisions : [];
          const results = new Map<string, RevisionSummary>();
          included.forEach((rev, i) => {
            const raw = rawRevisions[i];
            if (!raw) return;
            const { index: _ignoredIndex, isFinal: _ignoredIsFinal, ...summary } = raw;
            results.set(rev.versionKey, summary);
          });
          await Promise.all(
            included.map((rev) => {
              const summary = results.get(rev.versionKey);
              return summary ? store._db.saveSummary(sessionId, rev.index, rev.versionKey, summary).catch(() => {}) : null;
            }),
          );
          return results;
        })();

        fresh.forEach((rev) => {
          const perItem = batchPromise.then((results) => results.get(rev.versionKey));
          store._summaryPromises.set(rev.versionKey, perItem);
          perItem
            .finally(() => {
              if (store._summaryPromises.get(rev.versionKey) === perItem) store._summaryPromises.delete(rev.versionKey);
            })
            .catch(() => {});
        });
      }

      await Promise.all(
        need.map(async (rev) => {
          const promise = store._summaryPromises.get(rev.versionKey);
          if (!promise) return;
          const summary = await promise.catch(() => undefined);
          if (summary) out.set(rev.versionKey, summary);
        }),
      );
      return out;
    }

    /**
     * Background fetch of every unloaded summary in batches of at most 8MB /
     * 8 files, re-rendering after each so "Signed" shows up without expanding.
     */
    async function loadAllSummaries(sessionId: string): Promise<void> {
      const pending = (store.revisions() ?? []).filter((rev) => !rev.loaded);
      if (!pending.length) return;
      for (const batch of batchBySize(pending, 8 * 1024 * 1024, 8)) {
        if (sessionId !== currentSession()) return;
        const results = await ensureSummariesLoaded(sessionId, batch).catch(() => new Map<string, RevisionSummary>());
        if (sessionId !== currentSession()) return;
        applySummaries(results);
      }
    }

    function selectorsFor(display: RevisionEntry[]): void {
      if (display.length < 2) {
        patchState(store, { compareFrom: display[0]?.index ?? null, compareTo: display[0]?.index ?? null });
        return;
      }
      patchState(store, { compareFrom: display[0].index, compareTo: display[display.length - 1].index });
    }

    async function loadIfNeeded(): Promise<void> {
      const sessionId = currentSession();
      if (!doc.activeFile() || !sessionId) {
        patchState(store, { revisions: null, loadedFor: null, error: null });
        return;
      }
      // Keyed by activeVersionKey: an index alone can be reused for other bytes.
      const cacheKey = `${sessionId}:${doc.activeVersionKey()}`;
      if (store.loadedFor() === cacheKey && store.revisions()) return;

      if (store.loading()) {
        // Rerun once the in-flight load settles so the panel ends current.
        store._flags.reloadPending = true;
        return;
      }
      patchState(store, { loading: true, error: null });

      try {
        const metas = await store._db.listMeta(sessionId);
        if (sessionId !== currentSession()) return;
        if (!metas.length) {
          throw new Error(
            'No local version snapshots found for this document. This browser (or a private/incognito window) may be blocking local storage, which version history relies on.',
          );
        }
        // Paint instantly from what's already local; fetch the rest in the background.
        const revisions: RevisionEntry[] = metas.map((meta, i) => ({
          ...(meta.summary ? { ...meta.summary, loaded: true } : { loaded: false }),
          index: meta.index,
          versionKey: meta.versionKey,
          byteLength: meta.byteLength,
          source: meta.source,
          saveKind: meta.saveKind,
          isFinal: i === metas.length - 1,
        }));
        patchState(store, { revisions, loadedFor: cacheKey });
        selectorsFor(store.displayRevisions());
        loadAllSummaries(sessionId).catch(() => {});
      } catch (err) {
        if (sessionId !== currentSession()) return;
        patchState(store, { revisions: null, loadedFor: null, error: errorMessage(err) });
      } finally {
        if (sessionId === currentSession()) {
          patchState(store, { loading: false });
          if (store._flags.reloadPending) {
            store._flags.reloadPending = false;
            loadIfNeeded();
          }
        }
      }
    }

    async function toggleCard(index: number): Promise<void> {
      const expanded = new Set(store.expanded());
      const opening = !expanded.has(index);
      if (opening) expanded.add(index);
      else expanded.delete(index);
      patchState(store, { expanded: [...expanded] });

      const rev = store.revisions()?.find((r) => r.index === index);
      if (!opening || !rev || rev.loaded) return;
      const sessionId = currentSession();
      if (!sessionId) return;
      patchState(store, {
        revisions: (store.revisions() ?? []).map((r) => (r.index === index ? { ...r, detailState: 'loading' } : r)),
      });
      try {
        const results = await ensureSummariesLoaded(sessionId, [rev]);
        if (sessionId !== currentSession()) throw new Error('Document changed.');
        if (!results.get(rev.versionKey)) throw new Error('Could not read this revision.');
        applySummaries(results);
      } catch (err) {
        patchState(store, {
          revisions: (store.revisions() ?? []).map((r) =>
            r.index === index ? { ...r, detailState: `Error loading details: ${errorMessage(err)}` } : r,
          ),
        });
      }
    }

    // ---------------------------------------------------------------------
    // Viewer modes: single-revision View, plain diff page, visual diff
    // ---------------------------------------------------------------------

    function enterDiffViewMode(): void {
      viewer.enterDiffMode();
    }

    function exitDiffViewMode(): void {
      engine.releaseAll();
      patchState(store, { revisionViewIndex: null, revisionViewPage: 1, legend: null });
      clearActiveSelection();
      viewer.leaveDiffMode();
    }

    async function renderRevisionViewPage(num: number): Promise<void> {
      const revDoc = engine.revisionViewDoc;
      if (!revDoc) return;
      const clamped = Math.min(Math.max(num, 1), revDoc.numPages);
      patchState(store, { revisionViewPage: clamped });
      const page = await revDoc.getPage(clamped);
      const viewport = viewer.fittedViewport(page);
      viewer.viewport.set(viewport);
      const rendered = await viewer.renderToCanvas(page, viewport);
      if (!rendered) return;
      viewer.indicatorPage.set(clamped);
      viewer.indicatorCount.set(revDoc.numPages);
      viewer.prevDisabled.set(clamped <= 1);
      viewer.nextDisabled.set(clamped >= revDoc.numPages);
      viewer.diffBannerText.set(
        `Viewing Version ${store.revisionViewIndex()} snapshot (read-only) — page ${clamped} / ${revDoc.numPages}`,
      );
    }

    async function viewRevision(index: number): Promise<void> {
      const sessionId = currentSession();
      try {
        const revDoc = await engine.fetchRevisionDoc(sessionId, index);
        if (sessionId !== currentSession()) {
          revDoc.destroy();
          return;
        }
        if (engine.revisionViewDoc && engine.revisionViewDoc !== revDoc) engine.revisionViewDoc.destroy();
        engine.revisionViewDoc = revDoc;
        patchState(store, { revisionViewIndex: index, selectedView: index });
        enterDiffViewMode();
        await renderRevisionViewPage(1);
      } catch (err) {
        store._signatures().setStatus(`Could not open revision ${index}: ${errorMessage(err)}`, 'error');
      }
    }

    async function downloadRevision(index: number): Promise<void> {
      try {
        const blob = await store._db.getBlob(currentSession() ?? '', index);
        if (!blob) throw new Error(`Version ${index} is not available locally.`);
        const baseName = (doc.activeFile()?.name || 'document.pdf').replace(/\.pdf$/i, '');
        downloadBlob(blob, `${baseName}-revision-${index}.pdf`);
      } catch (err) {
        store._signatures().setStatus(`Download failed: ${errorMessage(err)}`, 'error');
      }
    }

    function setLegend(count: number | null, note: string): void {
      patchState(store, { legend: Number.isInteger(count) ? { count: count as number, note } : null });
    }

    function syncDiffIndicators(maxPages: number): void {
      const page = store.diffPage();
      viewer.indicatorPage.set(page);
      viewer.indicatorCount.set(maxPages || 1);
      viewer.prevDisabled.set(page <= 1);
      viewer.nextDisabled.set(page >= maxPages);
    }

    async function ensureDocsForRender(generation: number, label: string): Promise<boolean> {
      const fromLabel = store.diffFrom() ?? '?';
      const toLabel = store.diffTo() ?? '?';
      if (!engine.docA && !engine.docB) {
        viewer.diffBannerText.set(`Comparing Version ${fromLabel} → ${toLabel} — loading ${label}…`);
        try {
          await engine.ensureDocs();
        } catch {
          if (!engine.docA && !engine.docB) {
            viewer.diffBannerText.set(`Comparing Version ${fromLabel} → ${toLabel} — ${label} unavailable.`);
            return false;
          }
        }
        if (generation !== engine.generation) return false;
        if (!engine.docA && !engine.docB) return false;
      }
      return true;
    }

    function clampDiffPage(): number {
      const maxPages = engine.maxPages();
      let page = store.diffPage();
      if (page > maxPages) page = maxPages;
      if (page < 1) page = 1;
      patchState(store, { diffPage: page, diffMaxPages: maxPages });
      return maxPages;
    }

    async function renderVisualDiffView(): Promise<void> {
      const generation = ++engine.generation;
      enterDiffViewMode();
      if (!(await ensureDocsForRender(generation, 'snapshots'))) return;
      const maxPages = clampDiffPage();
      syncDiffIndicators(maxPages);
      viewer.diffBannerText.set(
        `Comparing Version ${store.diffFrom() ?? '?'} → ${store.diffTo() ?? '?'} — page ${store.diffPage()} / ${maxPages}`,
      );
      try {
        const result =
          store.visualStyle() !== 'outline'
            ? await engine.renderHighlights(
                store.diffPage(),
                store.visualColor(),
                String((engine.docB && store.diffPage() <= engine.docB.numPages ? store.diffFrom() : store.diffTo()) ?? '?'),
              )
            : await engine.renderOutlines(store.diffPage());
        if (generation !== engine.generation) return;
        setLegend(result.markCount, result.note);
      } catch (err) {
        if (generation !== engine.generation) return;
        if (err && typeof err === 'object' && (err as { name?: string }).name === 'RenderingCancelledException') return;
        viewer.diffBannerText.set(`Visual diff error: ${errorMessage(err)}`);
      }
    }

    /** Overview/Details keep the diff in the viewer too, as the plain "to" page. */
    async function renderDiffPlainView(): Promise<void> {
      const generation = ++engine.generation;
      enterDiffViewMode();
      if (!(await ensureDocsForRender(generation, 'snapshot'))) return;
      const maxPages = clampDiffPage();
      const page = store.diffPage();
      // Prefer the "to" page; fall back to "from" rather than showing nothing.
      const pdfDoc = engine.docB && page <= engine.docB.numPages ? engine.docB : engine.docA;
      if (!pdfDoc || page > pdfDoc.numPages) {
        viewer.diffBannerText.set('Page not available in either version.');
        return;
      }
      const pdfPage = await pdfDoc.getPage(page);
      if (generation !== engine.generation) return;
      const viewport = viewer.scaled(pdfPage.getViewport({ scale: viewer.scale() }), viewer.scale());
      viewer.viewport.set(viewport);
      viewer.diffMarkers.set([]);
      viewer.manyDiffMarkers.set(false);
      const rendered = await viewer.renderToCanvas(pdfPage, viewport);
      if (!rendered || generation !== engine.generation) return;
      syncDiffIndicators(maxPages);
      viewer.diffBannerText.set(`Comparing Version ${store.diffFrom() ?? '?'} → ${store.diffTo() ?? '?'} — page ${page} / ${maxPages}`);
    }

    function renderCurrentTabView(): Promise<void> {
      return store.activeTab() === 'visual' ? renderVisualDiffView() : renderDiffPlainView();
    }

    // ---- On-page previews of a changed object/row ----

    function drawPreviewMarkers(pdfRects: PdfRect[]): void {
      if (!pdfRects.length || !viewer.viewport()) return;
      viewer.diffMarkers.set(pdfRects.map((rect) => ({ rect, invisible: isRectPracticallyInvisible(rect) })));
      viewer.afterRender().then(() => {
        store._document
          .querySelector('.diff-object-hover-overlay')
          ?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
      });
    }

    async function previewObject(objectKey: string, pageIndex: number, pdfRects: PdfRect[], side: 'from' | 'to' = 'to'): Promise<void> {
      if (pageIndex < 0 || !pdfRects.length) return;
      const revIndex = side === 'from' ? store.diffFrom() : store.diffTo();
      if (!Number.isInteger(revIndex)) return;
      store._flags.lastPreview = { mode: 'object', objectKey, pageIndex, pdfRects, side };
      patchState(store, { hoveredKey: objectKey });

      engine.generation++;
      try {
        await engine.ensureDocs();
      } catch {
        /* one side may still have loaded */
      }
      if (store.hoveredKey() !== objectKey) return;
      enterDiffViewMode();

      if (side === 'from') {
        // The "to" page no longer has it -- render the "from" page plainly.
        const fromDoc = engine.docA;
        if (!fromDoc) return;
        const page = await fromDoc.getPage(pageIndex + 1);
        const viewport = viewer.scaled(page.getViewport({ scale: viewer.scale() }), viewer.scale());
        viewer.viewport.set(viewport);
        viewer.diffMarkers.set([]);
        const rendered = await viewer.renderToCanvas(page, viewport);
        if (!rendered || store.hoveredKey() !== objectKey) return;
        viewer.manyDiffMarkers.set(false);
        viewer.diffBannerText.set(`Previewing ${diffPreviewLabel(objectKey)} on Version ${store.diffFrom()} — page ${pageIndex + 1}`);
        drawPreviewMarkers(pdfRects);
        return;
      }

      patchState(store, { diffPage: pageIndex + 1 });
      await renderCurrentTabView();
      if (store.hoveredKey() !== objectKey) return;
      viewer.diffBannerText.set(`Previewing ${diffPreviewLabel(objectKey)} on Version ${store.diffTo()} — page ${pageIndex + 1}`);
      drawPreviewMarkers(pdfRects);
    }

    /** A whole-page pixel diff (content streams): every visible change on the page. */
    async function previewVisualPage(objectKey: string, pageIndex: number): Promise<number | null> {
      if (!Number.isInteger(store.diffTo()) || !Number.isInteger(store.diffFrom()) || pageIndex < 0) return null;
      store._flags.lastPreview = { mode: 'visual-page', objectKey, pageIndex };
      patchState(store, { hoveredKey: objectKey });
      engine.generation++;
      await engine.ensureDocs();
      if (store.hoveredKey() !== objectKey) return null;
      enterDiffViewMode();
      const { markCount } = await engine.renderOutlines(pageIndex + 1);
      if (store.hoveredKey() !== objectKey) return null;
      viewer.diffBannerText.set(
        markCount === 0
          ? `No visible difference on page ${pageIndex + 1} — the change is in the PDF source only.`
          : `All visible changes on page ${pageIndex + 1} — from this content stream and any annotations on it`,
      );
      return markCount;
    }

    function replayPreview(): void {
      const preview = store._flags.lastPreview;
      if (!preview) return;
      if (preview.mode === 'visual-page') {
        previewVisualPage(preview.objectKey, preview.pageIndex).catch(() => {});
        return;
      }
      previewObject(preview.objectKey, preview.pageIndex, preview.pdfRects, preview.side).catch(() => {});
    }

    function clearActiveSelection(): void {
      store._flags.lastPreview = null;
      patchState(store, { hoveredKey: null, activeObjectId: null, chipStatus: {} });
      viewer.diffMarkers.set([]);
    }

    /** Clearing a preview re-renders the plain diff for the current page. */
    function clearPreview(): void {
      clearActiveSelection();
      renderCurrentTabView();
    }

    /** A Details-tab chip's "Show on page": toggles its on-page preview. */
    function toggleChipPreview(objectId: string, item: RawObjectPreview, side: 'from' | 'to'): void {
      const page = item.page;
      if (page === null || !Number.isInteger(page)) return;
      const isActive = store.activeObjectId() === objectId && store.hoveredKey() === item.key;
      patchState(store, { chipStatus: {}, activeObjectId: null });
      if (isActive) {
        clearPreview();
        return;
      }
      patchState(store, { activeObjectId: objectId });
      viewer.diffMarkers.set([]);
      const reset = () => {
        if (store.activeObjectId() === objectId) patchState(store, { activeObjectId: null });
      };
      if (item.previewMode === 'visual-page') {
        previewVisualPage(item.key, page)
          .then((markCount) => {
            if (markCount === null || store.activeObjectId() !== objectId) return;
            patchState(store, {
              chipStatus: {
                [objectId]:
                  markCount === 0
                    ? `No visible difference on page ${page + 1} — the change is in the PDF source only.`
                    : `${markCount} visible change${markCount === 1 ? '' : 's'} marked on page ${page + 1}.`,
              },
            });
          })
          .catch(reset);
        return;
      }
      previewObject(item.key, page, item.rects, side).catch(reset);
    }

    /** A located field/signature row in Details: same toggle, keyed by the row. */
    function toggleRowLocate(key: string, pageIndex: number, pdfRects: PdfRect[], side: 'from' | 'to'): void {
      if (!Number.isInteger(pageIndex) || !pdfRects.length) return;
      const isActive = store.activeObjectId() === key && store.hoveredKey() === key;
      patchState(store, { chipStatus: {}, activeObjectId: null });
      if (isActive) {
        clearPreview();
        return;
      }
      patchState(store, { activeObjectId: key });
      viewer.diffMarkers.set([]);
      previewObject(key, pageIndex, pdfRects, side).catch(() => {
        if (store.activeObjectId() === key) patchState(store, { activeObjectId: null });
      });
    }

    // ---------------------------------------------------------------------
    // Compare sheet
    // ---------------------------------------------------------------------

    function openCompareSheet(): void {
      ui.openSheet('compare');
    }

    function closeCompareSheet(): void {
      ui.closeSheet('compare');
    }

    function resetDiffState(): void {
      closeCompareSheet();
      engine.resetForNewDocument();
      store._flags.suspended = null;
      clearActiveSelection();
      patchState(store, {
        diff: null,
        diffFrom: null,
        diffTo: null,
        activeTab: 'overview',
        diffPage: 1,
        pendingLandingTab: null,
        diffLoading: false,
        diffError: null,
        compareSubject: '',
        legend: null,
        compareFrom: null,
        compareTo: null,
        rawModal: null,
      });
    }

    async function compare(): Promise<void> {
      const sessionId = currentSession();
      if (!doc.activeFile() || !sessionId) return;
      const from = store.compareFrom();
      const to = store.compareTo();
      if (!Number.isInteger(from) || !Number.isInteger(to)) return;

      patchState(store, { compareSubject: 'Comparing…' });
      openCompareSheet();
      // Compare supersedes a single-revision View still open.
      if (engine.revisionViewDoc) {
        engine.closeRevisionView();
        patchState(store, { revisionViewIndex: null });
      }
      engine.setPair(sessionId, from!, to!);
      patchState(store, { diffFrom: from, diffTo: to, diffPage: 1, diff: null, diffError: null, diffLoading: true });

      const landing = store.pendingLandingTab();
      if (landing) patchState(store, { activeTab: landing, pendingLandingTab: null });

      try {
        const [fromBlob, toBlob] = await Promise.all([store._db.getBlob(sessionId, from!), store._db.getBlob(sessionId, to!)]);
        if (!fromBlob || !toBlob) throw new Error('One of the selected revisions is not available locally.');
        if (sessionId !== currentSession()) return;

        const formData = new FormData();
        formData.append('from', fromBlob, `revision-${from}.pdf`);
        formData.append('to', toBlob, `revision-${to}.pdf`);
        const res = await store._api.postForm('/api/revisions/diff', formData);
        let data: { diff?: RevisionDiff } & ErrorPayload;
        try {
          data = await res.json();
        } catch {
          throw new Error(`Server returned status ${res.status}.`);
        }
        if (!res.ok || !data.diff) throw new Error(data?.error || 'Could not compute the diff.');
        if (sessionId !== currentSession()) return;

        // A new comparison starts filters fresh (pre-filled by a cross-link).
        patchState(store, {
          diff: data.diff,
          compareSubject: compareVerdict(data.diff),
          rawFilter: { term: store.pendingFilterTerm() || '', categories: [], locatableOnly: false },
          pendingFilterTerm: null,
          chipStatus: {},
        });

        // Warm the snapshots the diff view renders from, in the background.
        try {
          await engine.ensureDocs();
        } catch {
          /* keep whichever side loaded */
        }
        if (sessionId !== currentSession()) return;
        renderCurrentTabView();
      } catch (err) {
        if (sessionId !== currentSession()) return;
        patchState(store, { diffError: errorMessage(err), compareSubject: '' });
      } finally {
        if (sessionId === currentSession()) patchState(store, { diffLoading: false });
      }
    }

    /** One click from a card straight to a rendered diff of that pair. */
    function runQuickDiff(fromIndex: number, toIndex: number, landOnTab: DiffTab = 'overview'): Promise<void> {
      patchState(store, { compareFrom: fromIndex, compareTo: toIndex, pendingLandingTab: landOnTab });
      return compare();
    }

    function switchTab(target: DiffTab): void {
      patchState(store, { activeTab: target });
      clearActiveSelection();
      renderCurrentTabView();
    }

    /** Leaving Versions hands the viewer back; remember what was up to restore it. */
    function suspend(): void {
      const sheetOpen = ui.sheets.compare();
      if (viewer.diffActive() && engine.revisionViewDoc && Number.isInteger(store.revisionViewIndex())) {
        store._flags.suspended = {
          kind: 'revision',
          index: store.revisionViewIndex() as number,
          page: store.revisionViewPage(),
          sheetOpen,
        };
      } else if (sheetOpen || viewer.diffActive()) {
        store._flags.suspended = { kind: 'diff', sheetOpen, tab: store.activeTab(), page: store.diffPage() };
      } else {
        store._flags.suspended = null;
      }
      if (viewer.diffActive()) exitDiffViewMode();
      closeCompareSheet();
    }

    async function resume(): Promise<void> {
      const state = store._flags.suspended;
      store._flags.suspended = null;
      if (!state) return;
      if (state.kind === 'revision') {
        await viewRevision(state.index);
        if (state.page > 1) await renderRevisionViewPage(state.page);
        return;
      }
      if (!store.diff()) return;
      if (state.sheetOpen) openCompareSheet();
      patchState(store, { diffPage: state.page });
      await renderCurrentTabView();
    }

    return {
      loadIfNeeded,
      toggleCard,
      viewRevision,
      downloadRevision,
      renderRevisionViewPage,
      exitDiffViewMode,
      renderCurrentTabView,
      renderVisualDiffView,
      previewObject,
      previewVisualPage,
      toggleChipPreview,
      toggleRowLocate,
      replayPreview,
      clearPreview,
      clearActiveSelection,
      openCompareSheet,
      closeCompareSheet,
      resetDiffState,
      compare,
      runQuickDiff,
      switchTab,
      suspend,
      resume,
      invalidateList(): void {
        patchState(store, { revisions: null, loadedFor: null });
      },
      snapshotList(): VersionsListSnapshot {
        return { revisions: store.revisions(), loadedFor: store.loadedFor() };
      },
      restoreList(snapshot: VersionsListSnapshot): void {
        patchState(store, { revisions: snapshot.revisions as RevisionEntry[] | null, loadedFor: snapshot.loadedFor });
      },
      toggleStack(firstIndex: number, memberIndices: number[], open: boolean): void {
        const stacks = new Set(store.expandedStacks());
        const expanded = new Set(store.expanded());
        if (open) {
          stacks.delete(firstIndex);
          // Collapse the cards inside too, or an expanded member holds it open.
          memberIndices.forEach((i) => expanded.delete(i));
        } else {
          stacks.add(firstIndex);
        }
        patchState(store, { expandedStacks: [...stacks], expanded: [...expanded] });
      },
      setOnlyIncremental(on: boolean): void {
        try {
          localStorage.setItem(ONLY_INCREMENTAL_STORAGE_KEY, on ? '1' : '0');
        } catch {
          /* best-effort persistence only */
        }
        patchState(store, { onlyIncremental: on });
        selectorsFor(store.displayRevisions());
      },
      /** From/To stay mutually constrained to a valid pair (From strictly before To). */
      setCompareFrom(fromIndex: number): void {
        const validTo = store.displayRevisions().filter((r) => r.index > fromIndex);
        const currentTo = store.compareTo();
        patchState(store, {
          compareFrom: fromIndex,
          compareTo: validTo.some((r) => r.index === currentTo) ? currentTo : (validTo[0]?.index ?? null),
        });
      },
      setCompareTo(toIndex: number): void {
        const validFrom = store.displayRevisions().filter((r) => r.index < toIndex);
        const currentFrom = store.compareFrom();
        patchState(store, {
          compareTo: toIndex,
          compareFrom: validFrom.some((r) => r.index === currentFrom)
            ? currentFrom
            : (validFrom[validFrom.length - 1]?.index ?? null),
        });
      },
      setVisualStyle(style: DiffMarkStyle): void {
        patchState(store, { visualStyle: style });
        renderVisualDiffView();
      },
      setVisualColor(color: PenColor): void {
        patchState(store, { visualColor: color });
        renderVisualDiffView();
      },
      visualPrev(): void {
        if (store.diffPage() <= 1) return;
        patchState(store, { diffPage: store.diffPage() - 1 });
        renderVisualDiffView();
      },
      visualNext(): void {
        if (store.diffPage() >= engine.maxPages()) return;
        patchState(store, { diffPage: store.diffPage() + 1 });
        renderVisualDiffView();
      },
      /** Main viewer prev/next while a diff is up. */
      diffPrev(): void {
        if (store.diffPage() <= 1) return;
        patchState(store, { diffPage: store.diffPage() - 1 });
        clearActiveSelection();
        renderCurrentTabView();
      },
      diffNext(): void {
        if (store.diffPage() >= engine.maxPages()) return;
        patchState(store, { diffPage: store.diffPage() + 1 });
        clearActiveSelection();
        renderCurrentTabView();
      },
      setChipStatus(objectId: string, text: string | null): void {
        const next = { ...store.chipStatus() };
        if (text) next[objectId] = text;
        else delete next[objectId];
        patchState(store, { chipStatus: next });
      },
      // ---- Raw object filter row ----
      setRawFilterTerm(term: string): void {
        patchState(store, { rawFilter: { ...store.rawFilter(), term } });
      },
      toggleRawCategory(category: string): void {
        const set = new Set(store.rawFilter().categories);
        if (set.has(category)) set.delete(category);
        else set.add(category);
        patchState(store, { rawFilter: { ...store.rawFilter(), categories: [...set] } });
      },
      setRawLocatableOnly(on: boolean): void {
        patchState(store, { rawFilter: { ...store.rawFilter(), locatableOnly: on } });
      },
      // ---- Raw object inspector modal ----
      openRawObject(item: RawObjectPreview, revisionIndex: number | null, objectId: string, side: 'from' | 'to'): void {
        patchState(store, { rawModal: { item, revisionIndex, objectId, side }, rawSourceTerm: '' });
      },
      closeRawObject(): void {
        patchState(store, { rawModal: null });
      },
      setRawSourceTerm(term: string): void {
        patchState(store, { rawSourceTerm: term });
      },
      /** Element history for the Overview sheet: every stored version's summary. */
      async loadedSummariesFor(sessionId: string | null): Promise<ElementVersionLike[]> {
        if (!sessionId) return [];
        const metas = await store._db.listMeta(sessionId);
        const revs = metas.map((m) => ({ index: m.index, versionKey: m.versionKey, loaded: !!m.summary, summary: m.summary }));
        const results = await ensureSummariesLoaded(sessionId, revs);
        return revs.map((rev): ElementVersionLike => {
          const summary: Partial<RevisionSummary> = results.get(rev.versionKey) ?? rev.summary ?? {};
          return {
            index: rev.index,
            parseError: summary.parseError,
            fields: summary.fields ?? undefined,
            signatures: summary.signatures,
            stamps: summary.stamps ?? undefined,
          };
        });
      },
      /** Waits for both indexes to appear in the picker, then runs the diff. */
      async openDiffWhenReady(from: number, to: number, tab: DiffTab, term: string | null): Promise<void> {
        const sessionId = currentSession();
        await waitFor(() => {
          if (sessionId !== currentSession()) return true;
          const have = new Set(store.displayRevisions().map((r) => r.index));
          return have.has(from) && have.has(to);
        }, 15000);
        if (sessionId !== currentSession()) return;
        patchState(store, { pendingFilterTerm: term || null });
        await runQuickDiff(from, to, tab);
      },
      /** Checklist row -> the tab that can show it (Details: scroll + flash the section). */
      async gotoChecklistTarget(target: { tab: DiffTab; section?: string }): Promise<void> {
        switchTab(target.tab);
        if (target.tab !== 'details' || !target.section) return;
        await viewer.afterRender();
        const el = store._document.querySelector(`#revisionsDiffResults [data-diff-section="${cssEscape(target.section)}"]`);
        if (!(el instanceof HTMLElement)) return;
        if (el instanceof HTMLDetailsElement) el.open = true;
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        el.classList.remove('is-flashed');
        void el.offsetWidth;
        el.classList.add('is-flashed');
      },
    };
  }),
  withHooks({
    onInit(store) {
      store._viewer.setDiffDelegate({
        hasRevisionView: () => !!store._engine.revisionViewDoc,
        revisionViewPage: () => store.revisionViewPage(),
        revisionViewPageCount: () => store._engine.revisionViewDoc?.numPages ?? 0,
        renderRevisionViewPage: (num) => store.renderRevisionViewPage(num),
        redrawDiff: () => {
          if (store._flags.lastPreview) store.replayPreview();
          else store.renderCurrentTabView();
        },
        diffPrev: () => store.diffPrev(),
        diffNext: () => store.diffNext(),
        exitDiffViewMode: () => store.exitDiffViewMode(),
      });
    },
  }),
);

export type VersionsStore = InstanceType<typeof VersionsStore>;
