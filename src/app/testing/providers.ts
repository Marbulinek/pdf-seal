import type { EnvironmentProviders, Provider } from '@angular/core';
import { provideRouter } from '@angular/router';
import { PORT_PROVIDERS } from '../core/port-providers';

/** What every TestBed needs: the port bindings and a router (UiService navigates). */
export function provideTestApp(): (Provider | EnvironmentProviders)[] {
  return [provideRouter([]), ...PORT_PROVIDERS];
}
