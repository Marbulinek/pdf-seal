// Injected into a frame's MAIN world through chrome.scripting.executeScript, which
// serializes it with toString(): it must stay self-contained (no references to
// module scope).
// - No argument (popup.js): lists the PDFs this frame can produce,
//   [{ id, kind, label, hint?, url?, crossOrigin?, unverified? }]. Each candidate is
//   checked first (its first bytes must be "%PDF-") and failures are left out;
//   `unverified` marks the ones that can't be checked in advance (CORS, POST forms).
// - With an id from that list (background.js): rescans and exports that one as
//   { ok, adapter, base64, name }, or { ok: false, fetch, name } when the page itself
//   can't fetch the URL (CORS), so the background retries with its own permissions.
// Supporting another source = one more add(kind, key, label, get) call.
export async function pdfsOnPage(exportId) {
  const B64 = /JVBERi0[A-Za-z0-9+/\s]{200,}={0,2}/g; // "JVBERi0" is base64 for "%PDF-"
  const found = [];
  const add = (kind, key, label, get, extra = {}) => {
    const id = `${kind}:${key}`;
    if (found.some((f) => f.id === id)) return;
    found.push({ id, kind, label: String(label || '').replace(/\s+/g, ' ').trim().slice(0, 120) || kind, get, ...extra });
  };
  const fromB64 = (s) => Uint8Array.fromBase64(s.replace(/\s+/g, ''));
  const isPdf = (bytes) => String.fromCharCode(...new Uint8Array(bytes).subarray(0, 5)) === '%PDF-';
  const UNVERIFIED = 'unverified';
  const fileName = (url) => { try { return decodeURIComponent(new URL(url).pathname.split('/').pop()); } catch { return ''; } };
  const isPdfPath = (u) => /\.pdf$/i.test(u.pathname);

  // Element/link URL → the PDF it shows: data:/blob: as-is, an http(s) URL with a
  // .pdf path (or a declared pdf type), or a viewer wrapper's ?file=…pdf parameter.
  const pdfUrl = (raw, { typeIsPdf = false, allowBlob = true } = {}) => {
    if (!raw) return;
    if (/^data:application\/pdf[;,]/i.test(raw)) return raw;
    let u;
    try { u = new URL(raw, location.href); } catch { return; }
    if (u.protocol === 'blob:') return allowBlob ? u.href : undefined;
    if (!/^https?:$/.test(u.protocol)) return;
    if (typeIsPdf || isPdfPath(u)) return u.href;
    for (const v of u.searchParams.values()) {
      try {
        const inner = new URL(v, u);
        if (/^https?:$/.test(inner.protocol) && isPdfPath(inner)) return inner.href;
      } catch { /* not a URL */ }
    }
  };
  // headOnly: read just the first chunk and cancel the rest of the download.
  const fetchUrl = async (url, headOnly = false) => {
    if (url.startsWith('data:')) {
      const comma = url.indexOf(',');
      if (/;base64$/i.test(url.slice(0, comma))) return fromB64(decodeURIComponent(url.slice(comma + 1)));
    }
    const abort = new AbortController();
    let res;
    try {
      res = await fetch(url, { credentials: 'include', signal: abort.signal });
    } catch (e) {
      if (/^https?:/.test(url)) e.retry = url; // most likely CORS
      throw e;
    }
    if (!res.ok) throw new Error(`${res.status} fetching ${url}`);
    if (!headOnly) return res.arrayBuffer();
    const reader = res.body.getReader();
    let head = new Uint8Array();
    while (head.length < 5) {
      const { done, value } = await reader.read();
      if (done) break;
      head = new Uint8Array([...head, ...value.subarray(0, 5)]);
    }
    abort.abort();
    return head;
  };
  const addUrl = (kind, url, label, extra = {}) => {
    const isHttp = /^https?:/.test(url);
    add(kind, isHttp || url.startsWith('blob:') ? url : `${url.length}:${url.slice(-40)}`, label, () => fetchUrl(url), {
      check: () => fetchUrl(url, true),
      name: isHttp ? fileName(url) : '',
      ...(isHttp || url.startsWith('blob:') ? { url } : {}),
      ...(isHttp && new URL(url).origin !== location.origin ? { crossOrigin: true } : {}),
      ...extra,
    });
  };

  // Nutrient / PSPDFKit: newest live instance first; unloaded ones throw and are skipped.
  // Only instances created in this frame's realm count: viewers running in an iframe
  // often also set window.parent.instance (nutrient.io/demo does), which would list the
  // same viewer again from the parent frame.
  const instances = [...new Set([...(window.__pdfSealInstances || []), window.instance])]
    .filter((i) => typeof i?.exportPDF === 'function' && i instanceof Object).reverse();
  if (instances.length) {
    add('nutrient', 'viewer', 'Nutrient viewer', async () => {
      for (const instance of instances) {
        try { return await instance.exportPDF(); } catch { /* unloaded */ }
      }
      throw new Error('the viewer was closed');
    }, { hint: 'Includes form values and annotations made in the viewer' });
  }

  // pdf.js viewer: saveDocument() includes its AcroForm edits.
  const pdfjs = window.PDFViewerApplication;
  if (pdfjs?.pdfDocument) {
    add('pdfjs', 'viewer', `pdf.js viewer: ${fileName(pdfjs.url) || document.title}`,
      () => pdfjs.pdfDocument.saveDocument(), { name: fileName(pdfjs.url), hint: 'Includes form values typed into the viewer' });
  }

  // This frame is a PDF (a PDF tab, or a frame Chrome's PDF viewer renders).
  if (document.contentType === 'application/pdf') {
    addUrl('tab', location.href, `This PDF: ${fileName(location.href) || location.href}`,
      { hint: "Values typed into Chrome's PDF viewer aren't included" });
  }

  for (const el of document.querySelectorAll('embed[src], object[data], iframe[src]')) {
    const raw = el.getAttribute(el.tagName === 'OBJECT' ? 'data' : 'src');
    const url = pdfUrl(raw, { typeIsPdf: /pdf/i.test(el.type || '') });
    if (url) addUrl('embed', url, `<${el.tagName.toLowerCase()}> ${/^(data|blob):/.test(url) ? `${url.slice(0, 4)} URL` : fileName(url) || url}`);
  }

  for (const a of [...document.querySelectorAll('a[href]')].slice(0, 500)) {
    if (found.filter((f) => f.kind === 'link').length >= 50) break;
    const url = pdfUrl(a.getAttribute('href'), { allowBlob: a.hasAttribute('download') });
    if (url) addUrl('link', url, `Link: ${a.textContent.trim() || a.download || fileName(url) || 'PDF'}`, a.download ? { name: a.download } : {});
  }

  // Bare base64 in text (inline <script>s included), form control values and attributes.
  // The src/data/href of the elements handled above are skipped; they're already listed.
  const addB64 = (text, where) => {
    for (const m of String(text).match(B64) || []) {
      const s = m.replace(/\s+/g, '');
      add('base64', `${s.length}:${s.slice(-40)}`, `Base64 in ${where}`, () => fromB64(s));
    }
  };
  const describe = (el) => `<${el.tagName.toLowerCase()}${el.name ? ` name="${el.name}"` : el.id ? ` id="${el.id}"` : ''}>`;
  const walker = document.createTreeWalker(document.documentElement || document, NodeFilter.SHOW_TEXT);
  for (let n; (n = walker.nextNode());) if (n.data.length > 200) addB64(n.data, n.parentElement ? describe(n.parentElement) : 'page text');
  for (const el of document.querySelectorAll('*')) {
    if (typeof el.value === 'string' && el.value.length > 200) addB64(el.value, describe(el));
    const handled = el.matches('embed, object, iframe, a');
    for (const attr of el.attributes) {
      if (attr.value.length > 200 && !(handled && ['src', 'data', 'href'].includes(attr.name))) addB64(attr.value, `${describe(el)} ${attr.name}`);
    }
  }

  // Captured by page/hook.js (whitelisted domains): fetch/XHR responses and object-URL Blobs.
  for (const c of window.__pdfSealCaptured || []) {
    add('captured', c.key, `Loaded by script: ${fileName(c.label) || c.label}`,
      () => (c.blob ? c.blob.arrayBuffer() : fromB64(c.base64)),
      { name: fileName(c.label), check: () => (c.blob ? c.blob.slice(0, 5).arrayBuffer() : fromB64(c.base64)) });
  }

  // Forms that look like they produce a PDF; exporting replays the submission.
  // ponytail: keyword heuristic on action + button; add an "all forms" toggle if a real page is missed.
  for (const [i, form] of [...document.forms].entries()) {
    const submitter = form.querySelector('button:not([type]), [type="submit"], [type="image"]');
    const buttonText = (submitter?.textContent || submitter?.value || submitter?.alt || '').trim();
    if (!/pdf|download|export|print|generat/i.test(`${form.getAttribute('action') || ''} ${buttonText} ${submitter?.name || ''}`)) continue;
    const method = form.method === 'post' ? 'POST' : 'GET';
    add('form', i, `Submit form: ${buttonText || form.name || form.id || form.action}`, async () => {
      const data = new FormData(form, submitter);
      const url = new URL(form.action);
      let body;
      if (method === 'GET') url.search = new URLSearchParams(data);
      else body = form.enctype === 'multipart/form-data' ? data : new URLSearchParams(data);
      const res = await fetch(url, { method, body, credentials: 'include' });
      if (!res.ok) throw new Error(`${res.status} from ${url.origin}${url.pathname}`);
      return res.arrayBuffer();
    }, {
      hint: 'Sends this form again, the same as clicking its button',
      // A GET is safe to send twice (check + export); a POST is only sent when picked.
      ...(method === 'POST' ? { check: async () => UNVERIFIED } : {}),
    });
  }

  if (exportId === undefined) {
    // Check every candidate in parallel (default: a full get(); URLs read only their first
    // bytes). ponytail: 10 s budget per check, a slower one is listed as unverified.
    const verdict = async (f) => {
      try {
        const result = await Promise.race([(f.check || f.get)(), new Promise((r) => setTimeout(r, 10000, UNVERIFIED))]);
        return result === UNVERIFIED ? UNVERIFIED : isPdf(result);
      } catch (e) {
        return e.retry ? UNVERIFIED : false; // the page can't fetch it; the background may
      }
    };
    const verdicts = await Promise.all(found.map(verdict));
    return found.flatMap(({ get, check, ...candidate }, i) => {
      if (!verdicts[i]) return [];
      return [verdicts[i] === UNVERIFIED ? { ...candidate, unverified: true } : candidate];
    });
  }

  const hit = found.find((f) => f.id === exportId);
  if (!hit) return { ok: false, error: 'That PDF is no longer on the page. Reopen the popup and try again.' };
  const name = (hit.name || document.title || 'document').replace(/[\\/:*?"<>|]+/g, '_').replace(/(\.pdf)?$/i, '.pdf');
  try {
    const bytes = new Uint8Array(await hit.get());
    if (!isPdf(bytes)) throw new Error('the data is not a PDF');
    return { ok: true, adapter: hit.kind, base64: bytes.toBase64(), name };
  } catch (e) {
    if (e.retry) return { ok: false, fetch: e.retry, adapter: hit.kind, name };
    return { ok: false, error: `${hit.kind}: ${e.message}` };
  }
}
