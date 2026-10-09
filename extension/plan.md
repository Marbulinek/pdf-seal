# pdfSeal Browser Extension: Implementation Plan

## Context

Documents are often open in third-party web apps that use **Nutrient Web SDK** (formerly PSPDFKit). Moving one into pdfSeal today takes several steps: download it, switch to pdfSeal, then upload it.

This plan adds a Manifest V3 **Chromium** extension under `/extension`. One click in its popup exports the PDF that is open in the current tab and opens it in a new pdfSeal tab, ready for signature fields.

Nutrient is the main target. Page export uses a small **adapter list**, so other viewers can be added later; pdf.js and a plain PDF URL are included as cheap extras.

**Decisions already made:**
- The send is triggered by a popup click only.
- The code lives in `/extension` in this repo.
- Plain JS with no build step, matching `public/`.
- Chromium only.

**Existing pdfSeal code this plan relies on** (`public/index.html`):
- `processNewFile(file, options)` at about line 3521. Every load path ends here: file input, drag and drop, Base64 modal, and share receive.
- `analyzeBase64Pdf(raw)` at about line 3087 returns `{ bytes, isPdf }` and checks for the `%PDF-` header. It is already used by the Base64 modal.
- `showNotification(msg, 'error')` for user-facing errors.
- Nothing receives documents from outside yet. There is no `message` listener, and `server.ts` sends no CSP, CORS or X-Frame headers, so nothing blocks this approach.
- The 25 MB upload cap (`MAX_UPLOAD_BYTES`, `server.ts:65`) still applies, because `processNewFile` uploads to `/api/info`.

---

## 1. System architecture and data flow

```
┌────────── Source tab (whitelisted site, e.g. app using Nutrient) ──────────┐
│ page/hook.js  (MAIN world, document_start, registered dynamically)         │
│   traps window.NutrientViewer / window.PSPDFKit → wraps .load()            │
│   → pushes every created instance into window.__pdfSealInstances           │
└──────────────────────────────────────▲─────────────────────────────────────┘
                                       │ (2) chrome.scripting.executeScript
popup.html ──(1) {type:'seal', tabId}──► background.js (service worker)
  Document tab: seal button            │     world:'MAIN', allFrames:true,
  Settings tab: env + whitelist        │     func: exportPdfFromPage  (page/export.js)
                                       │  ◄── {ok, adapter, name, base64}
                                       │ (3) chrome.tabs.create(pdfSeal URL), wait 'complete'
                                       │ (4) executeScript MAIN world in pdfSeal tab:
                                       ▼     window.postMessage({type:'pdfseal:import', base64, name})
┌────────────────────────── pdfSeal tab (public/index.html) ─────────────────┐
│ message listener → analyzeBase64Pdf() → processNewFile(new File(...))      │
└────────────────────────────────────────────────────────────────────────────┘
```

Design choices and the reasons for them:

- **There is no isolated-world bridge and no `window.postMessage` relay on the source page.**
  - `chrome.scripting.executeScript({ world: 'MAIN' })` runs the export function directly in the page's JS context and returns its resolved value to the background.
  - The capture hook also runs in the MAIN world.
  - Both scripts run in the MAIN world, so no relay script is needed.
- **The source tab only needs `activeTab`.** Clicking the popup grants `activeTab`, so export works on any tab without host permission.
- **The whitelist exists only for `hook.js`.**
  - Nutrient has no public registry of instances, so `.load()` must be wrapped before the page calls it.
  - That requires a script at `document_start` on known domains.
  - Without the hook, the export still tries `window.instance` (the name Nutrient examples use), plus the pdf.js and URL adapters.
- **Bytes travel as base64.** `executeScript` args and results must be JSON-serializable.
  - The page encodes with the native `Uint8Array.prototype.toBase64()`.
  - pdfSeal decodes with its existing `analyzeBase64Pdf()`.
  - The size ceiling is about 25 MB, the server cap, which is far below Chrome's 64 MB message limit.
- **pdfSeal accepts a message only when `event.source === window && event.origin === location.origin`.**
  - That is true only when the message is posted from inside the tab, which is what the extension's MAIN-world injection does.
  - Cross-origin openers and iframes cannot pass this check.
- **The background does the work, not the popup.** The popup closes as soon as the new tab opens, but the service worker keeps going.
  - Errors before the tab opens are returned to the popup.
  - Errors after that set a red `!` badge plus a tooltip on the action icon.

## 2. Directory structure

```
extension/
  plan.md            ← this plan
  manifest.json
  shared.js          ES module: ENVIRONMENTS, DEFAULTS, getSettings(), syncHook()
  background.js      ES module service worker: seal pipeline, onInstalled re-sync
  popup.html         two tabs: Document | Settings
  popup.css
  popup.js           ES module; imports shared.js
  page/
    hook.js          MAIN-world, document_start instance capture
    export.js        exportPdfFromPage(): self-contained adapter list (serialized by executeScript)
  icons/             16/48/128 PNGs derived from public/assets/favicon.png
  test/
    fake-nutrient.html   manual fixture: fake NutrientViewer whose exportPDF() returns a real PDF
```

The pdfSeal side changes only `public/index.html`, which gets one `message` listener. `AGENTS.md` and `README.md` each get a short section.

---

## 3. Implementation guide

### Phase 0: pdfSeal receiver (`public/index.html`)

Add the listener next to the share-from-URL bootstrap (about line 9292, `sharedSessionFromUrl`):

```js
// Documents pushed in by the pdfSeal browser extension (extension/): it
// injects this postMessage into the tab's own main world, so anything not
// posted by this window itself is ignored.
window.addEventListener('message', (event) => {
  if (event.source !== window || event.origin !== location.origin || event.data?.type !== 'pdfseal:import') return;
  let result;
  try { result = analyzeBase64Pdf(event.data.base64); } catch { result = null; }
  if (!result?.isPdf) { showNotification('The extension sent data that is not a PDF.', 'error'); return; }
  const name = /\.pdf$/i.test(event.data.name || '') ? event.data.name : 'document.pdf';
  processNewFile(new File([result.bytes], name, { type: 'application/pdf' }));
});
```

The listener is registered synchronously in the main inline script. By the time the tab reaches `status: 'complete'`, it is in place, so no ready handshake is needed.

### Phase 1: Manifest and storage

`manifest.json`:
```json
{
  "manifest_version": 3,
  "name": "PdfSeal Sender",
  "version": "0.1.0",
  "description": "Send the PDF open in a Nutrient (PSPDFKit) viewer to pdfSeal.",
  "action": { "default_popup": "popup.html", "default_icon": { "16": "icons/16.png", "48": "icons/48.png" } },
  "icons": { "16": "icons/16.png", "48": "icons/48.png", "128": "icons/128.png" },
  "background": { "service_worker": "background.js", "type": "module" },
  "permissions": ["activeTab", "scripting", "storage"],
  "host_permissions": ["http://localhost:3000/*", "https://pdf-seal-production.up.railway.app/*"],
  "optional_host_permissions": ["*://*/*"]
}
```

`shared.js`:
```js
export const ENVIRONMENTS = {
  production: 'https://pdf-seal-production.up.railway.app',
  local: 'http://localhost:3000',
};
export const DEFAULTS = { environment: 'production', customUrl: '', allowedDomains: ['http://localhost/*'] };
export const getSettings = async () => ({ ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) });
export const targetUrl = (s) => s.environment === 'custom' ? s.customUrl : ENVIRONMENTS[s.environment];

// Re-register the MAIN-world capture hook for exactly the whitelisted patterns.
export async function syncHook(patterns) {
  await chrome.scripting.unregisterContentScripts({ ids: ['pdfseal-hook'] }).catch(() => {});
  if (!patterns.length) return;
  await chrome.scripting.registerContentScripts([{
    id: 'pdfseal-hook', matches: patterns, js: ['page/hook.js'],
    world: 'MAIN', runAt: 'document_start', allFrames: true, persistAcrossSessions: true,
  }]);
}
```

Notes:
- `http://localhost/*` already matches every localhost port.
- `registerContentScripts` throws on a malformed pattern, and that error is shown in the Settings tab as the validation message. No hand-written pattern parser is needed.

### Phase 2: Popup UI (`popup.html`, `popup.css`, `popup.js`)

- **Tab bar:** two `<button role="tab">` elements with `aria-selected`, switching two `<section role="tabpanel">` elements by toggling `hidden`. No framework.
- **Document tab:**
  - A large seal button using the icon and the label "Send via PDF Seal Portal".
  - A status line `<p role="status">`.
  - A one-line hint with the current target URL.
  - Click flow: send `{ type: 'seal', tabId }` to the background (from `chrome.tabs.query({ active: true, currentWindow: true })`), show "Exporting…", then show the returned error or success. The popup closes when the new tab opens.
- **Settings tab:**
  - **Environment:** a `<select>` with Production, Local (localhost:3000) and Custom…. Picking Custom… shows a URL `<input type="url">`.
    - On save, a custom origin calls `chrome.permissions.request({ origins: [origin + '/*'] })`, because the background must inject into that tab.
  - **Allowed domains:** a `<textarea>` with one match pattern per line. This is easier to edit than a dynamic add/remove list.
  - **Save button, all inside the click handler** (the permission request needs the user gesture):
    1. Split and trim the lines and drop empty ones.
    2. Call `chrome.permissions.request({ origins: patterns })`. If it is denied, show an error and stop.
    3. Call `syncHook(patterns)`. If it throws, show the message, which is an invalid pattern.
    4. Call `chrome.permissions.remove()` for patterns that were removed since the last save.
    5. Save with `chrome.storage.sync.set(...)`.
    6. Show "Saved. Reload the target page for the hook to take effect."
- **Styling:** match pdfSeal's look by reusing the colour values from `public/styles.css`. Dark mode uses `prefers-color-scheme`.

### Phase 3: Background worker (`background.js`)

```js
import { getSettings, targetUrl, syncHook } from './shared.js';
import { exportPdfFromPage } from './page/export.js';

// Dynamically registered scripts are dropped on extension update.
chrome.runtime.onInstalled.addListener(async () => syncHook((await getSettings()).allowedDomains));

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type !== 'seal') return;
  seal(msg.tabId).then(reply, (e) => reply({ ok: false, error: e.message }));
  return true; // async reply
});

async function seal(sourceTabId) {
  chrome.action.setBadgeText({ text: '' });
  const frames = await chrome.scripting.executeScript({
    target: { tabId: sourceTabId, allFrames: true }, world: 'MAIN', func: exportPdfFromPage,
  });
  const found = frames.map((f) => f.result).find((r) => r?.ok);
  if (!found) return frames.map((f) => f.result).find((r) => r?.error) ?? { ok: false, error: 'No PDF viewer found on this page.' };

  const tab = await chrome.tabs.create({ url: targetUrl(await getSettings()) });
  await tabComplete(tab.id);
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id }, world: 'MAIN', args: [found.base64, found.name],
      func: (base64, name) => window.postMessage({ type: 'pdfseal:import', base64, name }, location.origin),
    });
  } catch (e) {
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setTitle({ title: `pdfSeal: ${e.message}` });
  }
  return { ok: true, adapter: found.adapter };
}

const tabComplete = (tabId) => new Promise((resolve) => {
  const onUpdated = (id, info) => { if (id === tabId && info.status === 'complete') { chrome.tabs.onUpdated.removeListener(onUpdated); resolve(); } };
  chrome.tabs.onUpdated.addListener(onUpdated);
});
```

### Phase 4: Content scripts and the Nutrient bridge (`page/`)

**`page/hook.js`** runs in the MAIN world at `document_start` on whitelisted domains. It captures instances when they are created, whether the SDK global already exists or is assigned later by a `<script>` tag:

```js
(() => {
  const seen = (window.__pdfSealInstances ||= []);
  const wrap = (sdk) => {
    if (!sdk || typeof sdk.load !== 'function' || sdk.__pdfSealWrapped) return sdk;
    const load = sdk.load;
    try {
      sdk.load = async function (...args) { const inst = await load.apply(this, args); seen.push(inst); return inst; };
      sdk.__pdfSealWrapped = true;
    } catch { /* frozen namespace (ESM import) -- export falls back to window.instance */ }
    return sdk;
  };
  for (const name of ['NutrientViewer', 'PSPDFKit']) {
    let sdk = wrap(window[name]);
    try {
      Object.defineProperty(window, name, { configurable: true, enumerable: true, get: () => sdk, set: (v) => { sdk = wrap(v); } });
    } catch { /* non-configurable global already defined */ }
  }
})();
```

The hook has one known limit. When the SDK is bundled through npm/ESM and never placed on `window`, there is nothing to trap. In that case the export falls back to a page-provided `window.instance`.

**`page/export.js`** exports a single **self-contained** function. `executeScript` serializes it with `toString()`, so it must not reference module scope. The adapters are tried in order:

```js
export async function exportPdfFromPage() {
  const toResult = (adapter, bytes, name) => ({
    ok: true, adapter, base64: new Uint8Array(bytes).toBase64(),
    name: (name || document.title || 'document').replace(/[\\/:*?"<>|]+/g, '_').replace(/(\.pdf)?$/i, '.pdf'),
  });
  const adapters = [
    // Nutrient / PSPDFKit: newest live instance first; unloaded ones throw and are skipped.
    ['nutrient', async () => {
      const list = [...(window.__pdfSealInstances || []), window.instance].filter((i) => typeof i?.exportPDF === 'function');
      for (const inst of list.reverse()) { try { return [await inst.exportPDF()]; } catch {} }
    }],
    // pdf.js viewer (incl. its form edits)
    ['pdfjs', async () => window.PDFViewerApplication?.pdfDocument && [await window.PDFViewerApplication.pdfDocument.saveDocument()]],
    // Plain PDF on the page: the tab itself or an <embed>/<iframe>/<object> pointing at one (same-origin/CORS-allowed only)
    ['url', async () => {
      const src = document.contentType === 'application/pdf' ? location.href
        : document.querySelector('embed[type="application/pdf"], object[type="application/pdf"], iframe[src*=".pdf"]')?.src
          ?? document.querySelector('object[type="application/pdf"]')?.data;
      if (!src) return;
      const res = await fetch(src, { credentials: 'include' });
      return res.ok && [await res.arrayBuffer(), decodeURIComponent(new URL(src).pathname.split('/').pop())];
    }],
  ];
  for (const [adapter, run] of adapters) {
    try { const hit = await run(); if (hit) return toResult(adapter, hit[0], hit[1]); }
    catch (e) { return { ok: false, error: `${adapter}: ${e.message}` }; }
  }
  return { ok: false };
}
```

To support another viewer later, add one `[name, async () => [bytes, name?]]` entry. Nothing else changes.

---

## 4. Task list

**Phase 0: pdfSeal receiver**
- [x] 0.1 Save this plan as `extension/plan.md`.
- [x] 0.2 Add the `pdfseal:import` `message` listener in `public/index.html`, next to `sharedSessionFromUrl`. It reuses `analyzeBase64Pdf`, `processNewFile` and `showNotification`.
- [ ] 0.3 Check it by hand: in DevTools on `localhost:3000`, run `window.postMessage({type:'pdfseal:import', base64: <sample b64>, name:'x.pdf'}, location.origin)`. The document should load. A cross-origin iframe posting the same message should be ignored.

**Phase 1: Manifest and storage**
- [x] 1.1 Create `extension/manifest.json` (above).
- [x] 1.2 Create `extension/icons/16|48|128.png`, resized from `public/assets/favicon.png` with `sips -z`.
- [x] 1.3 Create `extension/shared.js` with `ENVIRONMENTS`, `DEFAULTS`, `getSettings`, `targetUrl` and `syncHook`.

**Phase 2: Popup UI**
- [x] 2.1 Build `popup.html` with an accessible tab bar, a Document panel (seal button and status) and a Settings panel (environment select, custom URL, domains textarea, Save).
- [x] 2.2 Write `popup.css` with pdfSeal colours, dark mode and a fixed width of about 340px.
- [x] 2.3 In `popup.js`, switch tabs and load the settings into the form on open.
- [x] 2.4 In `popup.js`, handle Save: request permissions, run `syncHook`, revoke removed patterns, persist, and show errors from invalid patterns.
- [x] 2.5 In `popup.js`, wire the Seal button to the `seal` message and show the status or error.

**Phase 3: Background**
- [x] 3.1 In `background.js`, re-sync the hook in `onInstalled`.
- [x] 3.2 In `background.js`, implement `seal()`: export, choose the frame, open the tab, wait for it to load, inject.
- [x] 3.3 Show the error badge and title when injection into the pdfSeal tab fails.

**Phase 4: Page scripts**
- [x] 4.1 Write `page/hook.js`, which traps `NutrientViewer` and `PSPDFKit` and wraps `.load`.
- [x] 4.2 Write `page/export.js` with the `nutrient`, `pdfjs` and `url` adapters, base64 output and a sanitized name.
- [x] 4.3 Create `test/fake-nutrient.html`. It assigns `window.NutrientViewer = { load: async () => ({ exportPDF: () => fetch('/public/assets/demo/pdf-seal-sample.pdf').then(r => r.arrayBuffer()) }) }` from a `<script>` tag, then calls `NutrientViewer.load({})`. This exercises the setter trap.

**Phase 5: Docs**
- [x] 5.1 In `README.md`, add an "Browser extension" section: load unpacked from `extension/` and set up the whitelist.
- [x] 5.2 In `AGENTS.md`, add one architecture bullet:
  - The extension lives in `extension/`, uses plain JS, and is not covered by tsc or vitest.
  - The pdfSeal receiver contract is `pdfseal:import`.
  - The extension version is managed by hand, not by semantic-release.

## 5. Verification

1. `npm run build && npm test` should still pass. Only `index.html` changes on the app side, and tsc/vitest don't cover it.
2. `npm run dev`. In `chrome://extensions`, turn on Developer mode, choose **Load unpacked**, then pick `extension/`.
3. **Fake fixture:**
   1. Serve the repo root with `python3 -m http.server 8081`.
   2. Add `http://localhost/*` to the whitelist, set the environment to Local, and reload `http://localhost:8081/extension/test/fake-nutrient.html`.
   3. Click Seal. A new `localhost:3000` tab should open with the sample PDF loaded, fields listed and an entry in the Versions panel.
4. **Real Nutrient:** use a page that loads the SDK from Nutrient's CDN (trial mode, watermark is fine) and whose domain is whitelisted. The export should succeed with adapter `nutrient`, including annotations made in the viewer.
5. **Fallbacks:**
   - A non-whitelisted page that sets `window.instance` should still export.
   - A raw `.pdf` tab from the same origin should go through the `url` adapter.
   - A page with no viewer should show "No PDF viewer found on this page." in the popup.
6. **Settings:** an invalid pattern such as `foo` should show the error and not save. A removed pattern should disappear from the permissions on the extension's details page.
7. **Size:** a PDF over 25 MB should open in pdfSeal, with the existing server-side error for `/api/info`. This confirms the ceiling is the server's, not the extension's.

**Skipped, and when to add it:**
- Auto-send on load and a context-menu entry: add if the popup click turns out to be too slow in practice.
- Firefox: add if it is needed; it changes the background type and settings.
- Cross-origin fetch in the `url` adapter through the background: add when a real site's PDF is blocked by CORS.
