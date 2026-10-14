import { computed, effect, inject } from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { patchState, signalStore, withComputed, withHooks, withMethods, withProps, withState } from '@ngrx/signals';
import { elementVersionHistory } from '../../core/version-history';
import { atAGlanceChips, overviewItems, type OverviewItem, type OverviewKind } from './document-overview';
import { ApiService } from '../../core/api.service';
import { DocumentStore } from '../../core/document.store';
import { errorMessage } from '../../core/document.service';
import { isRectPracticallyInvisible } from '../../core/field-rules';
import type { InfoFullResponse } from '../../core/models';
import { toViewportRectangle } from '../../core/pdfjs-types';
import { UiService } from '../../core/ui.service';
import { lazyInject } from '../../core/util/lazy';
import { CERTIFICATES, SIGNATURES, VERSIONS } from '../../core/ports';
import { VersionStoreService } from '../../core/version-store.service';
import { ViewerService } from '../../core/viewer.service';
import { OVERVIEW_GROUPS, overviewSelector } from './overview-model';

export interface OverviewItemRef {
  kind: OverviewKind;
  key: string;
}

/** The page-map + cropped preview drawn in the detail sheet. */
export interface OverviewVisuals {
  id: string;
  file: File | null;
  map: { aspect: string; left: string; top: string; width: string; height: string };
  /** Offscreen canvas holding the crop; null with `note` when there's nothing visible. */
  snippet: HTMLCanvasElement | null;
  mark: { left: string; top: string; width: string; height: string } | null;
  note: string | null;
}

export interface ElementHistoryResult {
  loading: boolean;
  line: string;
  compare: { from: number; to: number; term: string } | null;
}

interface OverviewState {
  loading: boolean;
  error: string | null;
  /** Kinds whose hotspots are hidden on the PDF. */
  hiddenKinds: OverviewKind[];
  /** The item shown in the detail sheet. */
  activeItem: OverviewItemRef | null;
  /** The row hovered in the list (its hotspot highlights). */
  hoverItem: OverviewItemRef | null;
  /** Where a jump out of the sheet started, for "← Back to document". */
  diagnosticOrigin: (OverviewItemRef & { label: string }) | null;
  /** The certificate report was requested for the open sheet and has settled. */
  sheetSettled: boolean;
  visuals: OverviewVisuals | null;
  visualsPending: boolean;
  history: ElementHistoryResult | null;
  /** revisionCount -> whether the local versions are this file's native chain. */
  nativeChain: Record<number, boolean>;
}

const initialState: OverviewState = {
  loading: false,
  error: null,
  hiddenKinds: [],
  activeItem: null,
  hoverItem: null,
  diagnosticOrigin: null,
  sheetSettled: false,
  visuals: null,
  visualsPending: false,
  history: null,
  nativeChain: {},
};

/**
 * The Overview section: what the PDF is and everything on it. The heavy
 * /api/info summary is fetched lazily, only while this section is open.
 */
export const OverviewStore = signalStore(
  { providedIn: 'root' },
  withState(initialState),
  withProps(() => ({
    _doc: inject(DocumentStore),
    _api: inject(ApiService),
    _ui: inject(UiService),
    _viewer: inject(ViewerService),
    _versionsDb: inject(VersionStoreService),
    _document: inject(DOCUMENT),
    _certificates: lazyInject(CERTIFICATES),
    _signatures: lazyInject(SIGNATURES),
    _versions: lazyInject(VERSIONS),
  })),
  withComputed((store) => {
    const items = computed<OverviewItem[]>(() =>
      overviewItems({
        fields: store._doc.fields(),
        stamps: store._doc.documentStamps(),
        annotations: store._doc.documentAnnotations(),
      }),
    );
    const activeOverviewItem = computed(() => {
      const ref = store.activeItem();
      return ref ? (items().find((i) => i.kind === ref.kind && i.key === ref.key) ?? null) : null;
    });
    return {
      items,
      activeOverviewItem,
      chips: computed(() => atAGlanceChips(store._doc.documentOverview(), store._doc.fields())),
      groups: computed(() =>
        OVERVIEW_GROUPS.map((group) => {
          const rows = items().filter((i) => group.kinds.includes(i.kind));
          const hidden = group.kinds.every((k) => store.hiddenKinds().includes(k));
          return { ...group, rows, hidden };
        }).filter((g) => g.rows.length > 0),
      ),
      /** Stamps/links/comments with a rect on the shown page -- outlined while Overview is open. */
      hotspots: computed(() => {
        const page = store._viewer.pageNum() - 1;
        return overviewItems({ stamps: store._doc.documentStamps(), annotations: store._doc.documentAnnotations() })
          .filter((i) => i.page === page && i.rect)
          .map((item) => ({ item, invisible: isRectPracticallyInvisible(item.rect, item.kind) }));
      }),
    };
  }),
  withMethods((store) => {
    const doc = store._doc;
    const ui = store._ui;

    function itemFor(kind: string, key: string): OverviewItem | null {
      return store.items().find((i) => i.kind === kind && i.key === key) ?? null;
    }

    function closeSheet(): void {
      ui.closeSheet('overview');
      patchState(store, { activeItem: null, history: null });
    }

    function clearDiagnosticOrigin(): void {
      patchState(store, { diagnosticOrigin: null });
    }

    function rememberDiagnosticOrigin(): void {
      const active = store.activeItem();
      if (!active) return;
      patchState(store, { diagnosticOrigin: { ...active, label: itemFor(active.kind, active.key)?.label || active.key } });
    }

    /** Fetches the full /api/info summary for the active file, once per File. */
    async function loadIfNeeded(): Promise<void> {
      const file = doc.activeFile();
      if (!file || !doc.pdfDoc()) {
        doc.clearMeta();
        doc.update({ documentMetaLoadedFor: null });
        patchState(store, { error: null });
        return;
      }
      // Keyed by the File object itself: every load/edit produces a new File.
      if (doc.documentMetaLoadedFor() === file) return;
      if (store.loading()) return;
      patchState(store, { loading: true, error: null });
      closeSheet(); // whatever it showed described the previous document

      try {
        const formData = new FormData();
        formData.append('pdfDocument', file);
        const res = await store._api.postForm('/api/info', formData);
        const data = (await res.json()) as InfoFullResponse;
        if (!res.ok) throw new Error(data?.error || 'Could not load the document overview.');
        if (file !== doc.activeFile()) return; // superseded

        doc.update({
          documentMeta: data.metadata || null,
          documentRawInfo: data.rawInfo || null,
          documentStamps: data.stamps || [],
          documentAnnotations: data.annotations || [],
          documentOverview: data.overview || null,
          documentMetaLoadedFor: file,
        });

        // The signed chip and the signature sheet read the Certificates report.
        if ((data.overview?.features?.signatureCount || 0) > 0) {
          Promise.resolve(store._certificates().loadIfNeeded()).catch(() => {});
        }
      } catch (err) {
        if (file !== doc.activeFile()) return;
        patchState(store, { error: errorMessage(err) });
      } finally {
        // Always clear, even if the file changed mid-load.
        patchState(store, { loading: false });
      }
    }

    function openSheet(kind: OverviewKind, key: string): void {
      const item = itemFor(kind, key);
      if (!item) return;
      // Only one sheet slides over the column at a time.
      ui.closeSheet('certificate');
      ui.closeSheet('certificateTimeline');
      ui.closeSheet('compare');
      patchState(store, { activeItem: { kind, key }, sheetSettled: false, history: null });
      ui.openSheet('overview');
      renderVisuals(item);

      // A signed signature's detail comes from the Certificates report.
      if (kind === 'signature' && item.status === 'Signed' && !store._certificates().reportForActiveFile()) {
        const file = doc.activeFile();
        Promise.resolve(store._certificates().loadIfNeeded())
          .catch(() => {})
          .then(() => {
            if (file !== doc.activeFile() || !ui.sheets.overview()) return;
            const active = store.activeItem();
            if (active?.kind !== kind || active?.key !== key) return;
            patchState(store, { sheetSettled: true });
          });
      }
    }

    /** Row click: go to the page, flash the object, open its sheet. */
    async function activateItem(kind: OverviewKind, key: string): Promise<void> {
      const item = itemFor(kind, key);
      if (!item) return;
      openSheet(kind, key);
      await store._viewer.goToPageAndFlash(item.page, overviewSelector(item));
    }

    /** Snippet + mini page map for the sheet, cached per item and file. */
    async function renderVisuals(item: OverviewItem): Promise<void> {
      const pdfDoc = doc.pdfDoc();
      const file = doc.activeFile();
      if (!item.rect || !pdfDoc) {
        patchState(store, { visuals: null, visualsPending: false });
        return;
      }
      const id = `${item.kind}\u0000${item.key}`;
      const cached = store.visuals();
      if (cached?.id === id && cached.file === file) return;
      patchState(store, { visuals: null, visualsPending: true });
      const stillShown = () =>
        file === doc.activeFile() && store.activeItem()?.kind === item.kind && store.activeItem()?.key === item.key;

      let page;
      try {
        page = await pdfDoc.getPage(item.page + 1);
      } catch {
        patchState(store, { visualsPending: false });
        return;
      }
      if (!stillShown()) return;

      // Viewport space (top-left origin, rotation applied), in points.
      const base = page.getViewport({ scale: 1 });
      const r = item.rect;
      const [x1, y1, x2, y2] = toViewportRectangle(base, [r.x, r.y, r.x + r.width, r.y + r.height]);
      const box = { left: Math.min(x1, x2), top: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
      const pct = (v: number, of: number) => `${Math.max(0, Math.min(100, (v / of) * 100))}%`;
      const map = {
        aspect: `${base.width} / ${base.height}`,
        left: pct(box.left, base.width),
        top: pct(box.top, base.height),
        width: pct(box.width, base.width),
        height: pct(box.height, base.height),
      };

      let snippet: HTMLCanvasElement | null = null;
      let mark: OverviewVisuals['mark'] = null;
      let note: string | null = null;
      if (isRectPracticallyInvisible(item.rect, (item.source as { type?: string })?.type ?? item.kind)) {
        note = 'Not visible on the page — this object has no visible area.';
      } else {
        const pad = 18;
        const crop = {
          left: Math.max(0, box.left - pad),
          top: Math.max(0, box.top - pad),
          right: Math.min(base.width, box.left + box.width + pad),
          bottom: Math.min(base.height, box.top + box.height + pad),
        };
        const w = crop.right - crop.left;
        const h = crop.bottom - crop.top;
        // Fixed 560x280px budget (~2x the sheet width).
        const scale = Math.min(3, 560 / w, 280 / h);
        const canvasEl = store._document.createElement('canvas');
        canvasEl.width = Math.max(1, Math.ceil(w * scale));
        canvasEl.height = Math.max(1, Math.ceil(h * scale));
        const ctx = canvasEl.getContext('2d');
        if (!ctx) return;
        try {
          await page.render({
            canvas: null,
            canvasContext: ctx,
            viewport: page.getViewport({ scale }),
            transform: [1, 0, 0, 1, -crop.left * scale, -crop.top * scale],
          }).promise;
        } catch {
          patchState(store, { visualsPending: false });
          return;
        }
        snippet = canvasEl;
        mark = {
          left: pct(box.left - crop.left, w),
          top: pct(box.top - crop.top, h),
          width: pct(box.width, w),
          height: pct(box.height, h),
        };
      }
      if (!stillShown()) return;
      patchState(store, { visuals: { id, file, map, snippet, mark, note }, visualsPending: false });
    }

    /**
     * Whether local version i is boundary i of THIS file's own native chain
     * (so a revision number from the signature report links to a stored version).
     */
    async function checkNativeChain(revisionCount: number): Promise<void> {
      const sessionId = doc.documentSessionId();
      if (!sessionId || !Number.isInteger(revisionCount) || revisionCount < 2) return;
      if (revisionCount in store.nativeChain()) return;
      try {
        const metas = await store._versionsDb.listMeta(sessionId);
        const isNative =
          metas.length === revisionCount && metas.every((m) => m.saveKind === 'initial' || m.saveKind === 'incremental');
        if (sessionId !== doc.documentSessionId()) return;
        patchState(store, { nativeChain: { ...store.nativeChain(), [revisionCount]: isNative } });
      } catch {
        /* treated as "not native" */
      }
    }

    async function findElementHistory(): Promise<void> {
      const active = store.activeItem();
      if (!active) return;
      const { kind, key } = active;
      patchState(store, { history: { loading: true, line: 'Looking through stored versions…', compare: null } });
      const sessionId = doc.documentSessionId();
      let line: string;
      let compare: ElementHistoryResult['compare'] = null;
      try {
        const revs = await store._versions().loadedSummariesFor(sessionId);
        if (sessionId !== doc.documentSessionId()) return;
        const h = elementVersionHistory(revs, { kind, key });
        if (!h) {
          line = 'Not tracked by name in the stored versions. Open Versions to inspect manually.';
        } else {
          const lines: string[] = [];
          if (h.presentFromStart) lines.push('Present since the first stored version.');
          else lines.push(`First appears in Version ${h.firstIndex}.`);
          if (h.signedIndex !== null) lines.push(`Signed in Version ${h.signedIndex}.`);
          line = lines.join(' ');
          if (!h.presentFromStart && h.previousIndex !== null) compare = { from: h.previousIndex, to: h.firstIndex, term: key };
        }
      } catch (err) {
        line = `Could not read version history: ${errorMessage(err)}`;
      }
      patchState(store, { history: { loading: false, line, compare } });
    }

    /** Switches to Versions and opens the diff for from -> to (optionally pre-filtered). */
    async function openVersionsDiff(from: number, to: number, tab: 'overview' | 'details' | 'visual', term: string | null): Promise<void> {
      rememberDiagnosticOrigin();
      await ui.goToSection('revisions');
      await store._versions().openDiffWhenReady(from, to, tab, term);
    }

    return {
      itemFor,
      loadIfNeeded,
      openSheet,
      closeSheet,
      activateItem,
      checkNativeChain,
      findElementHistory,
      openVersionsDiff,
      rememberDiagnosticOrigin,
      clearDiagnosticOrigin,
      toggleGroup(groupId: string): void {
        const group = OVERVIEW_GROUPS.find((g) => g.id === groupId);
        if (!group) return;
        const hidden = new Set(store.hiddenKinds());
        const allHidden = group.kinds.every((k) => hidden.has(k));
        group.kinds.forEach((k) => (allHidden ? hidden.delete(k) : hidden.add(k)));
        patchState(store, { hiddenKinds: [...hidden] });
      },
      setHover(ref: OverviewItemRef | null): void {
        patchState(store, { hoverItem: ref });
      },
      async backToFinding(): Promise<void> {
        const origin = store.diagnosticOrigin();
        if (!origin) return;
        await ui.goToSection('metadata'); // also clears the origin
        await activateItem(origin.kind, origin.key);
      },
      /** "Open in Certificates" from a signed signature's sheet. */
      openInCertificates(fieldName: string): void {
        rememberDiagnosticOrigin();
        closeSheet();
        store._certificates().focusForField(fieldName);
      },
      /** An internal link's "Go to page N". */
      gotoPage(pageIndex: number): Promise<void> {
        return store._viewer.goToPageAndFlash(pageIndex, null);
      },
      /** "Edit in Signatures" from an unsigned signature's sheet. */
      editInSignatures(fieldName: string): void {
        rememberDiagnosticOrigin();
        store._signatures().showFieldOnDocument(fieldName);
      },
    };
  }),
  withHooks({
    onInit(store) {
      // body[data-overview-hide] hides those kinds' outlines (styles.css).
      effect(() => {
        store._document.body.dataset['overviewHide'] = store.hiddenKinds().join(' ');
      });
    },
  }),
);

export type OverviewStore = InstanceType<typeof OverviewStore>;
