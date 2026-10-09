import { getSettings, targetUrl, syncHook, isAllowed, notAllowedMessage } from './shared.js';
import { pdfsOnPage } from './page/export.js';

// Dynamically registered content scripts are dropped on extension update.
chrome.runtime.onInstalled.addListener(async () => syncHook((await getSettings()).allowedDomains));

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type !== 'seal') return;
  seal(msg).then(reply, (e) => reply({ ok: false, error: e.message }));
  return true; // async reply
});

// The page couldn't fetch this URL (CORS); the service worker can, for origins the
// extension holds a host permission for (the popup requests it before sending).
async function fetchHere({ fetch: url, adapter, name }) {
  let bytes;
  try {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error(`${res.status}`);
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch {
    return { ok: false, error: `Couldn't fetch ${new URL(url).origin}. Allow it when prompted, or add it to Allowed domains in Settings.` };
  }
  if (String.fromCharCode(...bytes.subarray(0, 5)) !== '%PDF-') return { ok: false, error: `${adapter}: the data is not a PDF` };
  return { ok: true, adapter, base64: bytes.toBase64(), name };
}

async function seal({ tabId: sourceTabId, frameId, id }) {
  chrome.action.setBadgeText({ text: '' });
  chrome.action.setTitle({ title: chrome.runtime.getManifest().action.default_title });
  const { url } = await chrome.tabs.get(sourceTabId);
  if (!isAllowed(url, (await getSettings()).allowedDomains)) return { ok: false, error: notAllowedMessage(url) };
  const [frame] = await chrome.scripting.executeScript({
    target: { tabId: sourceTabId, frameIds: [frameId] }, world: 'MAIN', func: pdfsOnPage, args: [id],
  });
  let found = frame?.result;
  if (found?.fetch) found = await fetchHere(found);
  if (!found?.ok) return found?.error ? found : { ok: false, error: 'Export failed.' };

  // From here on the popup is gone (the new tab took focus), so failures go to the badge.
  const tab = await chrome.tabs.create({ url: targetUrl(await getSettings()) });
  console.log('[seal] exported', found.adapter, found.name, found.base64.length, 'b64 chars; opened tab', tab.id);
  try {
    // A sleeping host (e.g. Railway cold start) can land the tab on an error page;
    // retry a few times instead of posting the PDF into the void.
    for (let attempt = 1; ; attempt++) {
      await tabComplete(tab.id);
      console.log('[seal] target tab loaded, posting import, attempt', attempt);
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id }, world: 'MAIN', args: [found.base64, found.name],
        func: (base64, name) => {
          if (typeof processNewFile !== 'function') return false; // not the PDF Seal app
          window.postMessage({ type: 'pdfseal:import', base64, name }, location.origin);
          return true;
        },
      }).catch(() => []); // Chrome's own net-error page refuses injection
      if (res?.result) break;
      if (attempt === 3) throw new Error('PDF Seal did not load. Try again in a moment.');
      await new Promise((r) => setTimeout(r, 2000));
      await chrome.tabs.reload(tab.id);
    }
    console.log('[seal] import posted');
  } catch (e) {
    console.error('[seal] hand-off failed', e);
    chrome.action.setBadgeBackgroundColor({ color: '#e63946' });
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setTitle({ title: `PDF Seal Portal: ${e.message}` });
  }
  return { ok: true, adapter: found.adapter };
}

function tabComplete(tabId) {
  return new Promise((resolve, reject) => {
    const done = (fn) => { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(onUpdated); fn(); };
    const timer = setTimeout(() => done(() => reject(new Error('PDF Seal tab did not finish loading.'))), 30000);
    const onUpdated = (id, info) => { if (id === tabId && info.status === 'complete') done(resolve); };
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}
