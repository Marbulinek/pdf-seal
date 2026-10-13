import { TestBed } from '@angular/core/testing';
import { DEFAULT_SETTINGS, SETTINGS_STORAGE_KEY, SettingsService, parseStoredSettings } from './settings.service';

describe('SettingsService', () => {
  beforeEach(() => localStorage.clear());

  it('parses stored settings, ignoring junk', () => {
    expect(parseStoredSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(parseStoredSettings('{not json')).toEqual(DEFAULT_SETTINGS);
    expect(parseStoredSettings(JSON.stringify({ templatesEnabled: true, showRawPdfData: 'yes' }))).toEqual({
      ...DEFAULT_SETTINGS,
      templatesEnabled: true,
    });
  });

  it('persists saves and toggles the body classes the CSS keys off', () => {
    const settings = TestBed.inject(SettingsService);
    TestBed.tick();
    expect(document.body.classList.contains('hide-signature-templates-panel')).toBe(true);

    settings.save({ ...DEFAULT_SETTINGS, templatesEnabled: true });
    TestBed.tick();
    expect(JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? '{}').templatesEnabled).toBe(true);
    expect(document.body.classList.contains('hide-signature-templates-panel')).toBe(false);
  });

  it('lets the tour override settings without touching storage', () => {
    const settings = TestBed.inject(SettingsService);
    settings.setDemoOverride({ showRawPdfData: true });
    expect(settings.effective().showRawPdfData).toBe(true);
    expect(settings.stored().showRawPdfData).toBe(false);
    settings.clearDemoOverride();
    expect(settings.effective().showRawPdfData).toBe(false);
  });

  it('resets the draft from storage when Settings opens', () => {
    const settings = TestBed.inject(SettingsService);
    settings.setDraft('trustSimulationEnabled', true);
    expect(settings.draft().trustSimulationEnabled).toBe(true);
    settings.refresh();
    expect(settings.draft().trustSimulationEnabled).toBe(false);
  });
});
