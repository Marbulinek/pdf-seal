import { Injectable, inject } from '@angular/core';
import { DocumentStore } from './document.store';

export interface UploadRequest<T> {
  promise: Promise<T>;
  abort(): void;
}

/**
 * Thin wrapper over fetch/XHR for the Express API. Every /api call is tagged
 * with the open document's id (X-Document-Id) so the server's log lines for it
 * can be found -- the id is shown in the footer's Diagnostics modal.
 */
@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly store = inject(DocumentStore);

  fetch(input: string, init: RequestInit = {}): Promise<Response> {
    const documentId = this.store.documentSessionId();
    if (!documentId || !input.startsWith('/api/')) return fetch(input, init);
    const headers = new Headers(init.headers);
    headers.set('X-Document-Id', documentId);
    return fetch(input, { ...init, headers });
  }

  postForm(url: string, body: FormData): Promise<Response> {
    return this.fetch(url, { method: 'POST', body });
  }

  /**
   * Server error responses are JSON (`{ "error": "..." }`); surface just the
   * message text instead of dumping the raw body into a toast.
   */
  async extractErrorMessage(response: Response): Promise<string> {
    const text = await response.text();
    try {
      const parsed = JSON.parse(text);
      return parsed?.error || text;
    } catch {
      return text;
    }
  }

  /**
   * XHR rather than fetch where upload progress matters (fetch has no
   * upload.onprogress). `responseType` decides what the promise resolves to.
   */
  upload<T>(
    url: string,
    body: FormData,
    opts: {
      responseType: XMLHttpRequestResponseType;
      onProgress?: (loaded: number, total: number) => void;
      errorMessage: (status: number) => string;
      networkError: string;
    },
  ): UploadRequest<T> {
    let xhr: XMLHttpRequest | null = null;
    const promise = new Promise<T>((resolve, reject) => {
      xhr = new XMLHttpRequest();
      xhr.open('POST', url);
      xhr.responseType = opts.responseType;
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) opts.onProgress?.(e.loaded, e.total);
      };
      xhr.onload = () => {
        if (xhr!.status >= 200 && xhr!.status < 300) resolve(xhr!.response as T);
        else reject(new Error(opts.errorMessage(xhr!.status)));
      };
      xhr.onerror = () => reject(new Error(opts.networkError));
      xhr.onabort = () => reject(new DOMException('Document loading was superseded.', 'AbortError'));
      xhr.send(body);
    });
    return {
      promise,
      abort: () => {
        if (xhr && xhr.readyState !== XMLHttpRequest.DONE) xhr.abort();
      },
    };
  }
}
