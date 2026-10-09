import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ENVIRONMENTS, injectHook, isAllowed, syncHook } from '../../extension/shared.js';

describe('extension isAllowed', () => {
  it('blocks sites outside the whitelist', () => {
    expect(isAllowed('https://www.nutrient.io/demo', ['http://localhost/*'])).toBe(false);
    expect(isAllowed('https://localhost/x', ['http://localhost/*'])).toBe(false);
    expect(isAllowed('https://evil-example.com/', ['https://*.example.com/*'])).toBe(false);
    expect(isAllowed('chrome://extensions/', ['*://*/*'])).toBe(false);
    expect(isAllowed(undefined, ['<all_urls>'])).toBe(false);
  });

  it('follows Chrome match-pattern rules', () => {
    expect(isAllowed('http://localhost:8081/extension/test/embeds.html', ['http://localhost/*'])).toBe(true);
    expect(isAllowed('https://www.nutrient.io/demo', ['https://www.nutrient.io/*'])).toBe(true);
    expect(isAllowed('https://nutrient.io/demo', ['*://*.nutrient.io/*'])).toBe(true);
    expect(isAllowed('https://a.b.nutrient.io/demo', ['*://*.nutrient.io/*'])).toBe(true);
    expect(isAllowed('https://app.example.com/docs/1?x=y', ['https://app.example.com/docs/*'])).toBe(true);
    expect(isAllowed('https://app.example.com/other', ['https://app.example.com/docs/*'])).toBe(false);
    expect(isAllowed('https://anything.test/', ['<all_urls>'])).toBe(true);
  });
});

// The extension may only touch pages on Allowed domains. These guard the places that inject code.
describe('extension injects only on Allowed domains', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('declares no static content scripts and no host access beyond PDF Seal itself', () => {
    const manifest = JSON.parse(readFileSync(new URL('../../extension/manifest.json', import.meta.url), 'utf8'));
    expect(manifest.content_scripts).toBeUndefined();
    expect(manifest.host_permissions.sort()).toEqual(Object.values(ENVIRONMENTS).map((o) => `${o}/*`).sort());
  });

  it('registers and injects the hook for exactly the Allowed domains', async () => {
    const patterns = ['https://app.example.com/*'];
    const chrome = {
      scripting: {
        unregisterContentScripts: vi.fn(async () => {}),
        registerContentScripts: vi.fn(async () => {}),
        executeScript: vi.fn(async () => []),
      },
      tabs: { query: vi.fn(async () => [{ id: 7 }]) },
    };
    vi.stubGlobal('chrome', chrome);

    await syncHook(patterns);
    expect(chrome.scripting.registerContentScripts.mock.calls[0][0][0].matches).toEqual(patterns);
    await injectHook(patterns);
    expect(chrome.tabs.query).toHaveBeenCalledWith({ url: patterns });
    expect(chrome.scripting.executeScript.mock.calls.map(([o]) => o.target.tabId)).toEqual([7]);

    chrome.scripting.registerContentScripts.mockClear();
    chrome.tabs.query.mockClear();
    await syncHook([]);
    await injectHook([]);
    expect(chrome.scripting.registerContentScripts).not.toHaveBeenCalled();
    expect(chrome.tabs.query).not.toHaveBeenCalled();
  });
});
