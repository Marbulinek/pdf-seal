import { getSettings, targetUrl, syncHook, injectHook, isAllowed, notAllowedMessage } from './shared.js';
import { pdfsOnPage } from './page/export.js';

const $ = (id) => document.getElementById(id);
const setStatus = (el, text, kind = '') => { el.textContent = text; el.className = kind; };

let saved = await getSettings();

// ---------- Tabs ----------
const tabs = [...document.querySelectorAll('[role="tab"]')];
for (const tab of tabs) {
  tab.addEventListener('click', () => {
    for (const t of tabs) {
      t.setAttribute('aria-selected', String(t === tab));
      $(t.getAttribute('aria-controls')).hidden = t !== tab;
    }
  });
}

// ---------- Document ----------
const renderTarget = () => { $('target').textContent = targetUrl(saved) || '(no URL set)'; };
renderTarget();

const KINDS = {
  nutrient: 'Nutrient', pdfjs: 'pdf.js', tab: 'PDF', embed: 'Embedded', link: 'Link',
  base64: 'Base64', captured: 'Script', form: 'Form',
};
const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

// Sites outside Allowed domains get a disabled button; re-checked after Settings are saved.
function checkAllowed() {
  const allowed = isAllowed(activeTab.url, saved.allowedDomains);
  let origin = activeTab.url || 'This page';
  try { origin = new URL(activeTab.url).host || origin; } catch { /* keep raw */ }
  $('siteOrigin').textContent = origin;
  $('siteState').textContent = allowed ? 'Allowed' : 'Not allowed';
  $('site').className = `site ${allowed ? 'allowed' : 'blocked'}`;
  $('sealBtn').disabled = !allowed;
  $('pdfList').hidden = true;
  setStatus($('status'), allowed ? '' : notAllowedMessage(activeTab.url), allowed ? '' : 'error');
}
checkAllowed();

// Scan every frame we can reach; one PDF can show up in two frames (an <iframe>
// element in the parent, and the PDF document inside it), so dedupe by URL.
async function scan() {
  // The tab may have navigated since the popup opened: never inject into a page outside Allowed domains.
  const { url } = await chrome.tabs.get(activeTab.id);
  if (!isAllowed(url, saved.allowedDomains)) throw new Error(notAllowedMessage(url));
  const frames = await chrome.scripting.executeScript({
    target: { tabId: activeTab.id, allFrames: true }, world: 'MAIN', func: pdfsOnPage,
  });
  const seen = new Set();
  return frames.flatMap((f) => (f.result || []).map((c) => ({ ...c, frameId: f.frameId })))
    .filter((c) => { const key = c.url ?? `${c.frameId}:${c.id}`; return !seen.has(key) && seen.add(key); });
}

async function send(picked) {
  const status = $('status');
  $('sealBtn').disabled = true;
  $('pdfList').inert = true;
  try {
    // Before anything async: permissions.request needs this click's user gesture.
    // It resolves without a prompt when the permission is already granted.
    if (picked.crossOrigin) await chrome.permissions.request({ origins: [`${new URL(picked.url).origin}/*`] });
    setStatus(status, 'Exporting…');
    const result = await chrome.runtime.sendMessage({ type: 'seal', tabId: activeTab.id, frameId: picked.frameId, id: picked.id });
    if (result?.ok) setStatus(status, `Sent via PDF Seal Portal (${result.adapter}).`, 'ok');
    else setStatus(status, result?.error || 'Export failed.', 'error');
  } catch (e) {
    setStatus(status, e.message, 'error');
  } finally {
    $('sealBtn').disabled = false;
    $('pdfList').inert = false;
  }
}

const pdfButton = (c) => {
  const button = Object.assign(document.createElement('button'), { type: 'button', className: 'pdf-item' });
  const text = Object.assign(document.createElement('span'), { className: 'pdf-label' });
  text.append(Object.assign(document.createElement('span'), { className: 'kind', textContent: KINDS[c.kind] || c.kind }), c.label);
  button.append(text);
  const hint = [c.hint, c.unverified && "Couldn't be checked in advance"].filter(Boolean).join('. ');
  if (hint) button.append(Object.assign(document.createElement('span'), { className: 'hint', textContent: hint }));
  button.addEventListener('click', () => send(c));
  return button;
};

$('sealBtn').addEventListener('click', async () => {
  const status = $('status');
  const list = $('pdfList');
  if (!targetUrl(saved)) return setStatus(status, 'Set a PDF Seal URL in Settings first.', 'error');
  $('sealBtn').disabled = true;
  list.hidden = true;
  setStatus(status, 'Looking for PDFs and checking them…');
  let candidates;
  try {
    candidates = await scan();
  } catch (e) {
    return setStatus(status, e.message, 'error');
  } finally {
    $('sealBtn').disabled = false;
  }
  if (!candidates.length) {
    return setStatus(status, 'No PDF found. If you just added this site in Settings, reload the tab so Nutrient viewers and PDFs loaded by scripts are seen.', 'error');
  }
  // A single checked PDF is sent right away. A cross-origin one still goes through the
  // list, because its permission prompt needs a fresh click (the scan outlived this one),
  // and so does an unverified one (e.g. a POST form shouldn't be submitted unasked).
  const [only] = candidates;
  if (candidates.length === 1 && !only.crossOrigin && !only.unverified) return send(only);
  list.replaceChildren(...candidates.map(pdfButton));
  list.hidden = false;
  setStatus(status, candidates.length > 1
    ? `Found ${candidates.length} PDFs. Pick the one to send:`
    : `Click the PDF to send it.${only.crossOrigin ? ' Chrome will ask to allow its site first.' : ''}`);
});

// ---------- Settings ----------
$('environment').value = saved.environment;
$('customUrl').value = saved.customUrl;
$('customUrl').hidden = saved.environment !== 'custom';
$('allowedDomains').value = saved.allowedDomains.join('\n');
$('environment').addEventListener('change', () => { $('customUrl').hidden = $('environment').value !== 'custom'; });

const customOriginPattern = (s) => (s.environment === 'custom' && s.customUrl ? `${new URL(s.customUrl).origin}/*` : null);

$('saveBtn').addEventListener('click', async () => {
  const status = $('settingsStatus');
  const next = {
    environment: $('environment').value,
    customUrl: $('customUrl').value.trim(),
    allowedDomains: [...new Set($('allowedDomains').value.split('\n').map((l) => l.trim()).filter(Boolean))],
  };
  let customPattern;
  try {
    if (next.environment === 'custom' && !/^https?:$/.test(new URL(next.customUrl).protocol)) throw new Error();
    customPattern = customOriginPattern(next);
  } catch {
    return setStatus(status, 'Enter a valid http(s) URL for the custom environment.', 'error');
  }

  // permissions.request needs the click's user gesture, so it goes first.
  const origins = [...next.allowedDomains, ...(customPattern ? [customPattern] : [])];
  try {
    if (origins.length && !(await chrome.permissions.request({ origins }))) {
      return setStatus(status, 'Permission was not granted; nothing saved.', 'error');
    }
    await syncHook(next.allowedDomains);
    await injectHook(next.allowedDomains);
  } catch (e) {
    return setStatus(status, e.message, 'error');
  }

  const stale = [...saved.allowedDomains, customOriginPattern(saved)].filter((p) => p && !origins.includes(p));
  if (stale.length) await chrome.permissions.remove({ origins: stale }).catch(() => {});

  await chrome.storage.sync.set(next);
  saved = next;
  renderTarget();
  checkAllowed();
  setStatus(status, 'Saved. Reload the tab you want to send from (the PDF Seal Portal only sees viewers loaded after saving).', 'ok');
});

document.getElementById("version").textContent = chrome.runtime.getManifest().version;
