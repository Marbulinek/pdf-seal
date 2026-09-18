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

Recorded before any change in this plan, on the 3-commit head of
`fix/performance-improvements` (`bc23d97`). Fill in after running the
scenarios above once against that commit; re-measure after each numbered
commit in the plan and compare.

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

Expected direction by the end of the plan (see the plan's own Verification
section for the full list): one full upload per fresh open (was 2) and one
per Apply (was 2); peak heap opening Revisions no longer scaling with
N x file size; startup no longer deserializing every stored PDF; ~900KB
less image data per visit.
