import { DOCUMENT } from '@angular/common';
import { Injectable, computed, effect, inject, signal } from '@angular/core';

export interface AppSettings {
  showRawPdfData: boolean;
  includeRevisionHistoryByDefault: boolean;
  templatesEnabled: boolean;
  certificateModifyEnabled: boolean;
  certificateScratchpadEnabled: boolean;
  trustSimulationEnabled: boolean;
}

export const SETTINGS_STORAGE_KEY = 'pdfseal-settings';

export const DEFAULT_SETTINGS: AppSettings = {
  showRawPdfData: false,
  includeRevisionHistoryByDefault: false,
  templatesEnabled: false,
  certificateModifyEnabled: false,
  certificateScratchpadEnabled: false,
  trustSimulationEnabled: false,
};

const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof AppSettings)[];

export function parseStoredSettings(raw: string | null): AppSettings {
  if (!raw) return { ...DEFAULT_SETTINGS };
  try {
    const parsed = JSON.parse(raw);
    const out = { ...DEFAULT_SETTINGS };
    for (const key of SETTING_KEYS) {
      if (parsed && typeof parsed[key] === 'boolean') out[key] = parsed[key];
    }
    return out;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Layers a temporary, in-memory settings override on top of the persisted
 * settings for the duration of the tour, without ever touching what's saved.
 * A null/undefined override hands back `stored` unchanged.
 */
export function mergeSettingsOverride<T extends object>(stored: T, override: Partial<T> | null | undefined): T {
  if (!override) return stored;
  return { ...stored, ...override };
}

/**
 * Persisted app preferences plus the demo tour's temporary override. The tour
 * can flip optional panels on (templates, raw data, ...) without ever touching
 * what's actually saved -- `effective` merges the two, `stored` is the truth.
 */
@Injectable({ providedIn: 'root' })
export class SettingsService {
  private readonly document = inject(DOCUMENT);

  readonly stored = signal<AppSettings>(this.load());
  readonly demoOverride = signal<Partial<AppSettings> | null>(null);
  readonly effective = computed(() => mergeSettingsOverride(this.stored(), this.demoOverride()));
  /**
   * The Settings modal's unsaved form. Reset from storage whenever the modal
   * opens; the tour flips it visually without anything being saved.
   */
  readonly draft = signal<AppSettings>({ ...this.stored() });

  constructor() {
    // The optional panels are shown/hidden by body classes styles.css keys off.
    effect(() => {
      const s = this.effective();
      const body = this.document.body.classList;
      body.toggle('hide-raw-pdf-data', !s.showRawPdfData);
      body.toggle('hide-signature-templates-panel', !s.templatesEnabled);
      body.toggle('hide-certificate-modify-panel', !s.certificateModifyEnabled);
      body.toggle('hide-certificate-scratchpad-panel', !s.certificateScratchpadEnabled);
      body.toggle('hide-trust-simulation-panel', !s.trustSimulationEnabled);
    });
  }

  load(): AppSettings {
    try {
      return parseStoredSettings(localStorage.getItem(SETTINGS_STORAGE_KEY));
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  save(next: AppSettings): void {
    try {
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* storage blocked -- the in-memory value still applies for this session */
    }
    this.stored.set({ ...next });
  }

  /** Re-reads storage (another tab may have saved) and resets the draft -- used when Settings opens. */
  refresh(): AppSettings {
    const s = this.load();
    this.stored.set(s);
    this.draft.set({ ...s });
    return s;
  }

  setDraft(key: keyof AppSettings, value: boolean): void {
    this.draft.update((d) => ({ ...d, [key]: value }));
  }

  setDemoOverride(patch: Partial<AppSettings>): void {
    this.demoOverride.update((current) => mergeSettingsOverride(current || {}, patch));
  }

  clearDemoOverride(): void {
    this.demoOverride.set(null);
  }
}
