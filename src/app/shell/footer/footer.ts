import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { UiService } from '../../core/ui.service';

export const EXTENSION_STORE_URL = 'https://chromewebstore.google.com/detail/pdf-seal-portal/aamkakilmifjonocbbfchhcbnbgajceh';

/** The extension is Chrome-only: other browsers get neither the modal nor the footer link. */
export function isGoogleChrome(): boolean {
  const nav = navigator as Navigator & { userAgentData?: { brands: { brand: string }[] } };
  return nav.userAgentData
    ? nav.userAgentData.brands.some((b) => b.brand === 'Google Chrome')
    : /Chrome\//.test(navigator.userAgent) && !/Edg\/|OPR\/|Firefox\//.test(navigator.userAgent);
}

@Component({
  selector: 'footer[appFooter]',
  templateUrl: './footer.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'site-footer' },
})
export class Footer {
  protected readonly ui = inject(UiService);
  protected readonly version = signal('Version …');
  protected readonly chrome = isGoogleChrome();
  protected readonly extensionUrl = EXTENSION_STORE_URL;

  constructor() {
    fetch('/api/version')
      .then(async (response) => {
        if (!response.ok) throw new Error('Unable to read version');
        const data = (await response.json()) as { version?: unknown };
        const version = typeof data.version === 'string' && data.version.trim() ? data.version : null;
        this.version.set(version ? `v.${version}` : 'Version unavailable');
      })
      .catch(() => this.version.set('Version unavailable'));
  }

  protected openDiagnostics(event: Event): void {
    event.preventDefault();
    this.ui.diagnosticsModalOpen.set(true);
  }

  protected openExtension(event: Event): void {
    event.preventDefault();
    this.ui.extensionModalOpen.set(true);
  }
}
