import { ApplicationConfig, inject, provideAppInitializer, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withComponentInputBinding, withInMemoryScrolling } from '@angular/router';
import { routes } from './app.routes';
import { DocumentService } from './core/document.service';
import { PORT_PROVIDERS } from './core/port-providers';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    ...PORT_PROVIDERS,
    // Created up front (not on first use) so the browser extension's hand-off
    // listener and its `window.processNewFile` probe exist as soon as the page loads.
    provideAppInitializer(() => {
      inject(DocumentService);
    }),
    provideRouter(
      routes,
      withComponentInputBinding(),
      // Section switches must never scroll the window -- the viewer keeps its place.
      withInMemoryScrolling({ scrollPositionRestoration: 'disabled' }),
    ),
  ],
};
