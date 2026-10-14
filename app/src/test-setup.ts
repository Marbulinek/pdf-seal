import { blockNetwork } from './app/testing/network';

// Global setup for the Angular unit tests (angular.json -> test.setupFiles).
// jsdom lacks a few browser APIs every browser Angular supports; stub them so
// components render in TestBed the way they do in the app.

// The viewer refits the page when its column resizes; jsdom never resizes.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class implements ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}

// jsdom has no canvas backend (it logs "Not implemented" on every call); the
// viewer never draws in unit tests, so a missing 2D context is enough.
HTMLCanvasElement.prototype.getContext = (() => null) as HTMLCanvasElement['getContext'];

// No spec ever reaches a server: real fetch/XHR/WebSocket calls fail fast, and
// a spec that needs one mocks it (app/src/app/testing/network.ts).
blockNetwork();
afterEach(() => vi.unstubAllGlobals());
