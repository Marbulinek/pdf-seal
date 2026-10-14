// Network mocks for the specs. The unit tests never talk to a server:
// test-setup.ts blocks fetch, XMLHttpRequest and WebSocket by default (see
// blockNetwork below), and a spec that exercises a server call mocks it here
// -- or swaps ApiService for a fake -- so `ng test` runs anywhere, CI included.

/** A JSON body with the given status, like the Express API answers. */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export interface FetchCall {
  url: string;
  init: RequestInit;
}

/**
 * Replaces the global fetch for the current test (restored after each test by
 * test-setup.ts). `handler` answers every request; the returned list records
 * what was asked for.
 */
export function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    return handler(url, init);
  });
  return calls;
}

function blocked(what: string): Error {
  return new Error(`Unit tests never reach a server: ${what} was not mocked (see app/src/app/testing/network.ts).`);
}

/**
 * Installed once by test-setup.ts: every real network API fails fast instead
 * of trying to reach a server that isn't there.
 */
export function blockNetwork(): void {
  globalThis.fetch = (input: RequestInfo | URL) => Promise.reject(blocked(`fetch(${String(input)})`));
  XMLHttpRequest.prototype.send = function () {
    throw blocked('XMLHttpRequest');
  };
  // A Proxy keeps WebSocket.OPEN & co., which the share code reads.
  globalThis.WebSocket = new Proxy(WebSocket, {
    construct(_target, args: unknown[]) {
      throw blocked(`WebSocket(${String(args[0])})`);
    },
  });
}
