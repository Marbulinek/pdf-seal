import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllGlobals(); });

// page/hook.js is a plain script; run it against stubbed browser globals.
it('captures a PDF transferred to a Web Worker (npm-bundled viewers)', async () => {
  class Worker { postMessage(message: { args: ArrayBuffer[] }) { structuredClone(message, { transfer: message.args }); } }
  class XMLHttpRequest { send() {} }
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('Worker', Worker);
  vi.stubGlobal('XMLHttpRequest', XMLHttpRequest);
  vi.stubGlobal('fetch', async () => new Response());
  new Function(readFileSync(new URL('../../extension/page/hook.js', import.meta.url), 'utf8'))();

  const pdf = new TextEncoder().encode('%PDF-1.7\n...\n%%EOF\n');
  const chunk = new TextEncoder().encode('%PDF-1.7\n...partial');
  const again = pdf.slice(); // the same document, posted a second time
  new Worker().postMessage({ args: [pdf.buffer, chunk.buffer] });
  new Worker().postMessage({ args: [again.buffer] });
  expect(pdf.byteLength).toBe(0); // transferred: only the hook's copy survives
  await new Promise((r) => setTimeout(r, 10));

  const captured = (globalThis as { __pdfSealCaptured?: { label: string; blob: Blob }[] }).__pdfSealCaptured!;
  expect(captured.map((c) => c.label)).toEqual(['PDF viewer']);
  expect(await captured[0].blob.text()).toBe('%PDF-1.7\n...\n%%EOF\n');
});
