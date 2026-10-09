export const ENVIRONMENTS = {
  production: 'https://pdf-seal-production.up.railway.app',
  local: 'http://localhost:3000',
};

export const DEFAULTS = { environment: 'production', customUrl: '', allowedDomains: ['http://localhost/*'] };

export const getSettings = async () => ({ ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) });

export const targetUrl = (s) => (s.environment === 'custom' ? s.customUrl : ENVIRONMENTS[s.environment]);

// Whether `url` matches one of the Allowed domains match patterns, following Chrome's
// rules: `*` scheme = http/https, `*.host` also matches the bare host, the port is
// ignored, and the path glob is checked against path + query.
export function isAllowed(url, patterns) {
  let u;
  try { u = new URL(url); } catch { return false; }
  const scheme = u.protocol.slice(0, -1);
  return patterns.some((pattern) => {
    if (pattern === '<all_urls>') return /^(https?|file|ftp|wss?)$/.test(scheme);
    const [, s, host, path] = /^(\*|[a-z][\w+.-]*):\/\/([^/]*)(\/.*)$/i.exec(pattern) || [];
    if (!path) return false;
    const hostname = host.replace(/:(\d+|\*)$/, '').toLowerCase();
    const glob = new RegExp(`^${path.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
    return (s === '*' ? /^https?$/.test(scheme) : s.toLowerCase() === scheme)
      && (hostname === '*' || hostname === u.hostname
        || (hostname.startsWith('*.') && (u.hostname === hostname.slice(2) || u.hostname.endsWith(hostname.slice(1)))))
      && glob.test(u.pathname + u.search);
  });
}

export const notAllowedMessage = (url) => {
  let origin = url;
  try { origin = new URL(url).origin; } catch { /* keep raw */ }
  return `This site isn't in Allowed domains. To send from it, add ${origin}/* in Settings and press Save.`;
};

// Re-register the MAIN-world capture hook (page/hook.js) for exactly the
// whitelisted patterns. registerContentScripts throws on a malformed pattern,
// which the Settings tab shows as its validation message.
export async function syncHook(patterns) {
  await chrome.scripting.unregisterContentScripts({ ids: ['pdfseal-hook'] }).catch(() => {});
  if (!patterns.length) return;
  await chrome.scripting.registerContentScripts([{
    id: 'pdfseal-hook', matches: patterns, js: ['page/hook.js'],
    world: 'MAIN', runAt: 'document_start', allFrames: true, persistAcrossSessions: true,
  }]);
}

// Registered scripts only run on future page loads, so also inject into tabs that
// are already open. ponytail: a viewer that already finished loading was never
// wrapped, so that tab still needs one reload.
export async function injectHook(patterns) {
  if (!patterns.length) return;
  for (const tab of await chrome.tabs.query({ url: patterns })) {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true }, world: 'MAIN', files: ['page/hook.js'],
    }).catch(() => {});
  }
}
