# Client performance & memory

Working notes for the `fix/performance-improvements` branch: how to measure
the client's PDF/memory/network overhead, the fixtures used to exercise it,
and the before/after numbers for each stage of the work.

## Fixtures

`npm run build:perf-fixtures` writes to `public/perf-fixtures/` (gitignored
and dockerignored, so it's never shipped -- the dev server just serves it
like any other file under `public/`):

| File | Purpose |
| --- | --- |
| `fields-60.pdf` | 30 pages, 60 fields (mix of invisible/required/read-only) -- field-heavy Apply/undo/overlay work |
| `large-images-200-fields.pdf` | ~15MB, 10 distinct noise images redrawn across 20 pages at 150px, plus 200 fields -- oversized-image and field-heavy load cost |
| `native-incremental-6.pdf` | A real classic-xref incremental-update chain: a pdf-lib base save (`useObjectStreams:false`) plus 5 hand-written increments, each its own `xref`/`trailer`/`startxref`/`%%EOF` -- exercises native-chain hydration |
| `bundled-history-12.pdf` | The app's own `PdfSealRevisionChainV1` format (`setRevisionSnapshotChain`) with 12 prior entries -- exercises bundled-chain hydration |
| `oversize-26mb.pdf` | ~27MB, over `MAX_UPLOAD_BYTES` (25MB) -- pdf.js renders it client-side, then `/api/info` returns 413, exercising rollback after a successful render |
| `corrupt.pdf` | A PDF-shaped header followed by garbage -- exercises the failed-load path |

Regenerate with:

```bash
npm run build:perf-fixtures
```

**Restart the dev server between measurement runs.** `uploadLimiter` allows
only 60 upload-shaped requests per 15 minutes per IP; a run that uploads
several fixtures a few times over will hit it.

## Instrumentation snippet

Paste into the browser devtools console once the app is loaded, before
running a scenario. It patches a few things in place so counts/bytes can be
read back afterward; nothing here is committed into `public/index.html`.

```js
(() => {
  const stats = {
    loadingTasks: 0,
    liveLoadingTasks: 0,
    apiCalls: 0,
    apiUploadBytes: 0,
    longTasks: 0,
    longTaskTotalMs: 0,
  };
  window.__perfStats = stats;

  // 1. Count live pdf.js loading tasks (documents that are open right now).
  // pdf.js's own namespace object exposes `getDocument` as a non-configurable
  // getter (it's an ESM export), so `pdfjsLib.getDocument = wrapped` silently
  // does nothing -- swap the *global binding* for a Proxy instead, which
  // intercepts property access without touching the real object at all.
  if (window.pdfjsLib && !window.pdfjsLib.__perfWrapped) {
    const realLib = window.pdfjsLib;
    const realGetDocument = realLib.getDocument.bind(realLib);
    window.pdfjsLib = new Proxy(realLib, {
      get(target, prop, receiver) {
        if (prop === '__perfWrapped') return true;
        if (prop === 'getDocument') {
          return (...args) => {
            stats.loadingTasks++;
            stats.liveLoadingTasks++;
            const task = realGetDocument(...args);
            task.promise
              .then((doc) => {
                const destroy = doc.destroy.bind(doc);
                doc.destroy = (...destroyArgs) => {
                  stats.liveLoadingTasks--;
                  return destroy(...destroyArgs);
                };
              })
              .catch(() => {
                stats.liveLoadingTasks--;
              });
            return task;
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  }

  // 2. Count /api/* calls and request body bytes, fetch + XHR.
  const bodyBytes = (body) => {
    if (!body) return 0;
    if (body instanceof Blob) return body.size;
    if (body instanceof ArrayBuffer) return body.byteLength;
    if (body instanceof FormData) {
      let total = 0;
      for (const value of body.values()) {
        if (value instanceof Blob) total += value.size;
        else total += new Blob([value]).size;
      }
      return total;
    }
    return new Blob([body]).size;
  };

  if (!window.fetch.__perfWrapped) {
    const originalFetch = window.fetch.bind(window);
    const wrappedFetch = (input, init) => {
      const url = typeof input === 'string' ? input : input?.url || '';
      if (url.includes('/api/')) {
        stats.apiCalls++;
        stats.apiUploadBytes += bodyBytes(init?.body);
      }
      return originalFetch(input, init);
    };
    wrappedFetch.__perfWrapped = true;
    window.fetch = wrappedFetch;
  }

  if (!XMLHttpRequest.prototype.send.__perfWrapped) {
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this.__perfUrl = url;
      return originalOpen.call(this, method, url, ...rest);
    };
    const wrappedSend = function (body) {
      if (typeof this.__perfUrl === 'string' && this.__perfUrl.includes('/api/')) {
        stats.apiCalls++;
        stats.apiUploadBytes += bodyBytes(body);
      }
      return originalSend.call(this, body);
    };
    wrappedSend.__perfWrapped = true;
    XMLHttpRequest.prototype.send = wrappedSend;
  }

  // 3. Long tasks (main-thread blocks >= 50ms).
  if (window.PerformanceObserver && !window.__perfLongTaskObserver) {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        stats.longTasks++;
        stats.longTaskTotalMs += entry.duration;
      }
    });
    try {
      observer.observe({ type: 'longtask', buffered: true });
      window.__perfLongTaskObserver = observer;
    } catch {
      // longtask not supported in this browser; skip.
    }
  }

  console.log('[perf] instrumentation installed. Read window.__perfStats and call window.__perfSnapshot() for a point-in-time reading.');
})();

window.__perfSnapshot = async () => {
  const snapshot = { ...window.__perfStats };
  snapshot.usedJSHeapMB = performance.memory
    ? +(performance.memory.usedJSHeapSize / (1024 * 1024)).toFixed(1)
    : null;
  snapshot.domNodeCount = document.getElementsByTagName('*').length;
  if (navigator.storage?.estimate) {
    const estimate = await navigator.storage.estimate();
    snapshot.storageUsageMB = +(estimate.usage / (1024 * 1024)).toFixed(1);
    snapshot.storageQuotaMB = +(estimate.quota / (1024 * 1024)).toFixed(1);
  }
  console.table(snapshot);
  return snapshot;
};
```

`performance.memory` is Chrome-only (needs `--enable-precise-memory-info` on
some versions, or just works in recent Chrome); run measurement scenarios in
Chrome/the built-in browser pane.

## Scenarios

Drive these through the page's own globals in the devtools console (all are
plain top-level functions in `public/index.html`'s script, so they hang off
`window`):

1. **Fresh upload, small file.** Upload `fields-60.pdf`. Snapshot after the
   document settles.
2. **Fresh upload, oversized images.** Upload `large-images-200-fields.pdf`.
   Snapshot after settle.
3. **Field-heavy Apply.** With `fields-60.pdf` open, move/edit several
   fields, then `await applyPendingFieldChanges()`. Snapshot before and
   after; note `apiCalls`/`apiUploadBytes` delta for exactly one Apply.
4. **Undo/redo churn.** `await undoFieldChange()` / redo five times in a
   row after a few Applies. Snapshot `liveLoadingTasks` (live pdf.js
   documents) after each.
5. **Open Revisions.** With `bundled-history-12.pdf` or
   `native-incremental-6.pdf` open, `await loadRevisionsIfNeeded()`.
   Snapshot `apiCalls`/`apiUploadBytes` and `usedJSHeapMB` before/after.
6. **Compare/diff.** `await runQuickDiff(1, 2)` (adjust indices to the open
   document's revision count). Snapshot `liveLoadingTasks` after -- it
   should return to its pre-diff value once the compare view closes.
7. **Startup cost.** Reload the page with a document already in IndexedDB
   from a prior scenario; snapshot immediately after load, before touching
   anything, to see what the startup sweep alone costs.
8. **Oversize rollback.** Upload `oversize-26mb.pdf`. It should render in
   pdf.js, then the `/api/info` call should fail (413) and the viewer
   should roll back to the previously open document (or an empty state)
   without a leaked `pdfDoc`. Snapshot `liveLoadingTasks` before and after
   -- it should not have grown.
9. **Corrupt file.** Upload `corrupt.pdf` after a good file is already
   open. The previous document should stay intact; `liveLoadingTasks`
   should not grow.

## Baseline

The table below was the plan for measuring every scenario above,
before-vs-after, against the 3-commit head of `fix/performance-improvements`
(`bc23d97`), using the instrumentation snippet. That full instrumented run
was not actually executed commit-by-commit during this work -- what follows
instead is what was concretely measured or directly observed while building
and browser-testing each commit. The scenarios and snippet above remain the
right tool for anyone who wants exact `apiCalls`/`usedJSHeapMB`/
`longTaskTotalMs` numbers for a specific pair of commits.

| Scenario | Metric | Before | After |
| --- | --- | --- | --- |
| Fresh upload, `fields-60.pdf` | `apiCalls` | | |
| Fresh upload, `large-images-200-fields.pdf` | `usedJSHeapMB` | | |
| One Apply on `fields-60.pdf` | `apiCalls` delta | | |
| One Apply on `fields-60.pdf` | `apiUploadBytes` delta | | |
| 5x undo/redo | peak `liveLoadingTasks` | | |
| Open Revisions on `bundled-history-12.pdf` | `apiCalls` | | |
| Open Revisions on `bundled-history-12.pdf` | `apiUploadBytes` | | |
| Startup sweep (reload with stored history) | `longTaskTotalMs` in first 2s | | |
| Oversize rollback | leaked `liveLoadingTasks` | | |

## What actually changed, commit by commit

- **`apply-changes returns the updated field list`** (`?withFields=true`) --
  removes one full `/api/info` re-upload of the just-saved PDF after every
  Apply, purely to learn the field list the server already had in hand.
- **`lightweight undo snapshots`** -- an undo/redo entry no longer carries a
  duplicated pdf.js document; it's the `File` plus cloned field arrays and a
  few identifiers. Restoring one only reopens a pdf.js document when it
  targets a different file than what's currently open (same-file field
  edits are the common case for undo/redo, and those no longer reopen
  anything).
- **`IndexedDB v2` + `delta storage`** -- replaced a single `pdfseal-revisions`
  store (one full PDF copy per version) with `pdfseal-versions`'
  `versionMeta`/`versionBytes`/`versionSessions` split, storing an
  incremental save's *appended tail only* rather than a second full copy.
  Measured directly against this repo's `native-incremental-6.pdf` fixture
  (6 versions, 5 of them true incremental saves): storing all 6 as full
  copies took roughly file-size x 6; storing versions 2-6 as deltas against
  their predecessor took roughly file-size x 1.2 -- about an 80% reduction
  for that fixture, verified via direct `versionBytes` object-store
  inspection plus a byte-exact reconstruction check through the
  `baseKey` chain.
- **`persisted, batched revision summaries`** -- a version's badge/
  diff-ability summary is computed once and cached in `versionMeta.summary`
  instead of re-derived from bytes on every Versions panel open, and
  summaries for entries still missing one are fetched in size-bounded
  batches (≤8MB/≤8 files per request) rather than one request per entry.
- **`client-side, streamed hydration`** -- removed the
  `/api/revisions/embedded` route entirely (confirmed unreachable: a direct
  POST to it now 404s, and network inspection during native/bundled/demo-
  sample uploads shows zero calls to it). Hydrating a newly opened file's
  prior revisions no longer uploads the whole file to the server, gets back
  every prior revision as base64 in one JSON response, and holds the whole
  chain in memory before writing it out -- it's decoded and written to
  IndexedDB one entry at a time, client-side.
- **`lazy UI parts`** -- concrete, directly measured numbers from this pass:
  - The four largest static images (the logo, always visible in the header,
    plus three seal illustrations shown in the pending-changes bar, the
    Help/remove-field modals, and the Share panel) went from ~1.1MB combined
    to ~84KB, resized in place to roughly 2x their largest on-page display
    size (all were originally served at up to 1919px wide for a ~230px-wide
    spot) and recompressed (JPEG quality 78).
  - `large-images-200-fields.pdf` (this repo's 200-field perf fixture):
    `drawFieldOverlays()` used to build ~200 fresh `createElement()` subtrees
    (~8 nodes each) and attach ~8 listeners per field -- around 1,400
    listeners -- on every single render (page turn, zoom, undo/redo, any
    field edit). Now one `<template>` clone per field and a fixed set of
    ~6 delegated listeners on `#overlay-layer` regardless of field count.
  - The Metadata raw tree's "All PDF Objects (raw)" branch (capped at 500
    entries) no longer builds and parses each object's own nested subtree
    into DOM until that specific `<details>` is actually opened -- checked
    directly: a freshly rendered tree has 0 characters of built HTML under
    an unopened branch, populated only on its first `toggle`.
  - Compare Revisions' Details tab (one card per changed object, each with
    badges/meta rows/dictionary-change lists) is now built on first visit
    to that tab rather than on every compare regardless of which tab the
    user lands on -- checked directly: `revisionsDiffResults` stays empty
    after a compare that lands on Overview, and switching to Details for
    the first time is what populates it.
