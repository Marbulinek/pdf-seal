// Runs in the page's MAIN world at document_start on whitelisted domains.
// Nutrient has no public registry of live instances, so wrap NutrientViewer.load /
// PSPDFKit.load (whether the global exists already or is assigned later by a
// <script> tag) and remember every instance it resolves to.
// An SDK bundled via npm/ESM (e.g. an Angular app) never touches window, so there is
// nothing to trap; its document is still caught on the way into the viewer's worker below.
(() => {
  if (window.__pdfSealHooked) return; // registered script + injectHook() can both run
  window.__pdfSealHooked = true;

  const seen = (window.__pdfSealInstances ||= []);
  const wrap = (sdk) => {
    if (!sdk || typeof sdk.load !== 'function' || sdk.__pdfSealWrapped) return sdk;
    const load = sdk.load;
    try {
      sdk.load = async function (...args) {
        const instance = await load.apply(this, args);
        seen.push(instance);
        return instance;
      };
      sdk.__pdfSealWrapped = true;
    } catch { /* frozen namespace object */ }
    return sdk;
  };
  for (const name of ['NutrientViewer', 'PSPDFKit']) {
    let sdk = wrap(window[name]);
    try {
      Object.defineProperty(window, name, {
        configurable: true, enumerable: true, get: () => sdk, set: (value) => { sdk = wrap(value); },
      });
    } catch { /* non-configurable global already defined */ }
  }

  // PDFs that only pass through scripts: fetch/XHR responses (a raw PDF, or base64
  // inside JSON/text) and Blobs handed to URL.createObjectURL (caught even after the
  // URL is revoked). page/export.js lists them as "Loaded by script".
  // Also PDFs posted to a Web Worker: Nutrient's WASM engine and pdf.js both run in one, so
// this catches viewers bundled into the app (no global to trap) -- the document as
// loaded, without annotations made in the viewer.
// ponytail: last 20 kept; a worker that fetches the URL itself stays invisible unless
// the main thread saw that response too.
  const captured = (window.__pdfSealCaptured ||= []);
  let nextKey = 0;
  const B64 = /JVBERi0[A-Za-z0-9+/\s]{200,}={0,2}/g; // "JVBERi0" is base64 for "%PDF-"
  const keep = (label, entry) => {
    captured.push({ key: nextKey++, label: /^data:/.test(label) ? 'data URL' : String(label || 'Blob'), ...entry });
    if (captured.length > 20) captured.shift();
  };
  const keepBlob = (label, blob) => blob.slice(0, 5).text()
    // Same size = same document seen twice (e.g. fetched, then posted to the viewer's worker).
    .then((head) => head === '%PDF-' && !captured.some((c) => c.blob?.size === blob.size) && keep(label, { blob }), () => {});
  // Raw bytes: checked synchronously and copied, because a buffer transferred to a worker
  // is detached right after. "%%EOF" near the end skips partial (range-request) chunks.
  const keepBytes = (label, value) => {
    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    const text = (b) => String.fromCharCode(...b);
    if (text(bytes.subarray(0, 5)) === '%PDF-' && text(bytes.subarray(-1024)).includes('%%EOF')) keepBlob(label, new Blob([bytes]));
  };
  const keepText = (label, text) => {
    for (const m of String(text).match(B64) || []) {
      const base64 = m.replace(/\s+/g, '');
      if (!captured.some((c) => c.base64 === base64)) keep(label, { base64 });
    }
  };
  const binaryType = (type) => !type || /pdf|octet-stream|download|binary/i.test(type);
  const textType = (type) => /json|text|xml/i.test(type) && !/event-stream/i.test(type);

  const fetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await fetch.apply(this, args);
    try {
      const type = res.headers.get('content-type') || '';
      if (binaryType(type)) res.clone().blob().then((b) => keepBlob(res.url, b), () => {});
      else if (textType(type)) res.clone().text().then((t) => keepText(res.url, t), () => {});
    } catch { /* body already used */ }
    return res;
  };

  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener('load', () => {
      try {
        const type = this.getResponseHeader('content-type') || '';
        const r = this.response;
        if (r instanceof Blob) keepBlob(this.responseURL, r);
        else if (r instanceof ArrayBuffer) keepBytes(this.responseURL, r);
        else if (this.responseType === 'json') keepText(this.responseURL, JSON.stringify(r));
        else if (['', 'text'].includes(this.responseType) && textType(type)) keepText(this.responseURL, this.responseText);
      } catch { /* unreadable response */ }
    });
    return send.apply(this, args);
  };

  // Walks a few levels of plain objects/arrays: viewers wrap the bytes in a message object.
  const findPdfs = (value, depth = 0) => {
    if (value instanceof Blob) keepBlob('PDF viewer', value);
    else if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) keepBytes('PDF viewer', value);
    else if (depth < 4 && (Array.isArray(value) || (value && Object.getPrototypeOf(value) === Object.prototype))) {
      for (const v of Object.values(value).slice(0, 50)) findPdfs(v, depth + 1);
    }
  };
  const postMessage = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function (message, ...rest) {
    try { findPdfs(message); } catch { /* never break the page */ }
    return postMessage.call(this, message, ...rest);
  };

  const createObjectURL = URL.createObjectURL;
  URL.createObjectURL = function (obj) {
    if (obj instanceof Blob && /^$|pdf|octet-stream/i.test(obj.type)) keepBlob(obj.name || 'Blob', obj);
    return createObjectURL.call(this, obj);
  };
})();
