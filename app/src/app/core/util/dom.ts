// Small DOM helpers that genuinely need the document (downloads, clipboard,
// animation restarts). Everything else in the app is declarative.

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Restarts the `.is-flashed` pulse on `el` and scrolls it into view. */
export function flashElement(el: Element | null | undefined): void {
  if (!(el instanceof HTMLElement)) return;
  el.classList.remove('is-flashed');
  void el.offsetWidth; // restart the animation
  el.classList.add('is-flashed');
  el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

export function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  return String(value).replace(/["\\]/g, '\\$&');
}

/**
 * Copies `text` to the clipboard, falling back to a hidden textarea +
 * execCommand on insecure (plain http, LAN IP) origins.
 */
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textArea = document.createElement('textarea');
  textArea.value = text;
  textArea.style.position = 'fixed';
  textArea.style.left = '-999999px';
  textArea.style.top = '-999999px';
  document.body.appendChild(textArea);
  textArea.focus();
  textArea.select();
  const successful = document.execCommand('copy');
  textArea.remove();
  if (!successful) throw new Error('Your browser blocked the fallback copy action.');
}

/** Resolves once `predicate()` is truthy, or false after `timeoutMs`. */
export function waitFor(predicate: () => unknown, timeoutMs = 4000): Promise<boolean> {
  return new Promise((resolve) => {
    const start = Date.now();
    (function poll() {
      let ok = false;
      try {
        ok = !!predicate();
      } catch {
        ok = false;
      }
      if (ok) return resolve(true);
      if (Date.now() - start >= timeoutMs) return resolve(false);
      setTimeout(poll, 80);
    })();
  });
}

export function runAtIdle(run: () => void, timeout: number, fallbackDelay: number): void {
  const w = window as Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number };
  if (typeof w.requestIdleCallback === 'function') w.requestIdleCallback(run, { timeout });
  else setTimeout(run, fallbackDelay);
}
