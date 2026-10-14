import { ChangeDetectionStrategy, Component, computed, inject, resource } from '@angular/core';
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
  protected readonly chrome = isGoogleChrome();
  protected readonly extensionUrl = EXTENSION_STORE_URL;

  private readonly appVersion = resource({
    loader: async ({ abortSignal }) => {
      const response = await fetch('/api/version', { signal: abortSignal });
      if (!response.ok) throw new Error('Unable to read version');
      const data = (await response.json()) as { version?: unknown };
      return typeof data.version === 'string' && data.version.trim() ? data.version : null;
    },
  });

  protected readonly version = computed(() => {
    if (this.appVersion.isLoading()) return 'Version …';
    const version = this.appVersion.hasValue() ? this.appVersion.value() : null;
    return version ? `v.${version}` : 'Version unavailable';
  });

  protected openDiagnostics(event: Event): void {
    event.preventDefault();
    this.ui.diagnosticsModalOpen.set(true);
  }

  protected openExtension(event: Event): void {
    event.preventDefault();
    this.ui.extensionModalOpen.set(true);
  }
}
