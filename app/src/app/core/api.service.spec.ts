import { TestBed } from '@angular/core/testing';
import { jsonResponse, mockFetch } from '../testing/network';
import { provideTestApp } from '../testing/providers';
import { ApiService } from './api.service';
import { DocumentStore } from './document.store';

/** A scripted XMLHttpRequest: the test decides how each request ends. */
class FakeXhr {
  static readonly DONE = 4;
  static last: FakeXhr | null = null;

  readonly upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = {
    onprogress: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  responseType: XMLHttpRequestResponseType = '';
  readyState = 0;
  status = 0;
  response: unknown = null;
  method = '';
  url = '';
  body: unknown = null;

  constructor() {
    FakeXhr.last = this;
  }
  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
    this.readyState = 1;
  }
  send(body: unknown): void {
    this.body = body;
  }
  abort(): void {
    this.readyState = FakeXhr.DONE;
    this.onabort?.();
  }
  respond(status: number, response: unknown): void {
    this.readyState = FakeXhr.DONE;
    this.status = status;
    this.response = response;
    this.onload?.();
  }
  fail(): void {
    this.readyState = FakeXhr.DONE;
    this.onerror?.();
  }
}

describe('ApiService', () => {
  let api: ApiService;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: provideTestApp() });
    api = TestBed.inject(ApiService);
    FakeXhr.last = null;
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
  });

  describe('fetch', () => {
    it('tags /api calls with the open document id', async () => {
      const calls = mockFetch(() => jsonResponse({}));
      TestBed.inject(DocumentStore).update({ documentSessionId: 'doc-123' });

      await api.fetch('/api/info', { method: 'POST' });
      await api.fetch('/assets/logo.png');

      expect(new Headers(calls[0].init.headers).get('X-Document-Id')).toBe('doc-123');
      expect(calls[0].init.method).toBe('POST');
      expect(new Headers(calls[1].init.headers).has('X-Document-Id')).toBe(false);
    });

    it('sends no document id while no document is open', async () => {
      const calls = mockFetch(() => jsonResponse({}));
      await api.fetch('/api/share-config');
      expect(new Headers(calls[0].init.headers).has('X-Document-Id')).toBe(false);
    });

    it('posts forms', async () => {
      const calls = mockFetch(() => jsonResponse({ ok: true }));
      const form = new FormData();
      form.append('fieldsOnly', 'true');
      const res = await api.postForm('/api/info', form);
      expect(await res.json()).toEqual({ ok: true });
      expect(calls[0].init.method).toBe('POST');
      expect(calls[0].init.body).toBe(form);
    });
  });

  describe('extractErrorMessage', () => {
    it('reads the message out of a JSON error body', async () => {
      expect(await api.extractErrorMessage(jsonResponse({ error: 'Not a PDF' }, 400))).toBe('Not a PDF');
    });

    it('falls back to the raw text', async () => {
      expect(await api.extractErrorMessage(new Response('Bad gateway', { status: 502 }))).toBe('Bad gateway');
      expect(await api.extractErrorMessage(jsonResponse({ other: 1 }, 400))).toBe('{"other":1}');
    });
  });

  describe('upload', () => {
    const opts = {
      responseType: 'json' as const,
      errorMessage: (status: number) => `Failed (${status})`,
      networkError: 'Network down',
    };

    it('posts the form, reports progress and resolves with the response', async () => {
      const progress: number[] = [];
      const form = new FormData();
      const req = api.upload<{ fields: unknown[] }>('/api/info', form, { ...opts, onProgress: (loaded, total) => progress.push(loaded / total) });
      const xhr = FakeXhr.last!;
      expect(xhr.method).toBe('POST');
      expect(xhr.url).toBe('/api/info');
      expect(xhr.responseType).toBe('json');
      expect(xhr.body).toBe(form);

      xhr.upload.onprogress?.({ lengthComputable: true, loaded: 50, total: 100 });
      xhr.upload.onprogress?.({ lengthComputable: false, loaded: 0, total: 0 });
      xhr.respond(200, { fields: [] });

      await expect(req.promise).resolves.toEqual({ fields: [] });
      expect(progress).toEqual([0.5]);
    });

    it('rejects with the status message on an HTTP error', async () => {
      const req = api.upload('/api/info', new FormData(), opts);
      FakeXhr.last!.respond(413, null);
      await expect(req.promise).rejects.toThrow('Failed (413)');
    });

    it('rejects with the network message when the request fails', async () => {
      const req = api.upload('/api/info', new FormData(), opts);
      FakeXhr.last!.fail();
      await expect(req.promise).rejects.toThrow('Network down');
    });

    it('aborts an in-flight request as an AbortError, and ignores a finished one', async () => {
      const req = api.upload('/api/info', new FormData(), opts);
      req.abort();
      await expect(req.promise).rejects.toMatchObject({ name: 'AbortError' });

      const done = api.upload('/api/info', new FormData(), opts);
      const xhr = FakeXhr.last!;
      xhr.respond(200, {});
      const abortSpy = vi.spyOn(xhr, 'abort');
      done.abort();
      expect(abortSpy).not.toHaveBeenCalled();
    });
  });
});
