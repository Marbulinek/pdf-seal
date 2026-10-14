import { TestBed } from '@angular/core/testing';
import { provideTestApp } from '../testing/providers';
import { DEFAULT_SETTINGS, SettingsService } from './settings.service';
import { UiService } from './ui.service';

describe('UiService', () => {
  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({ providers: provideTestApp() });
  });

  it('snaps the Signatures panel back to Add when templates are turned off', () => {
    const settings = TestBed.inject(SettingsService);
    const ui = TestBed.inject(UiService);
    settings.save({ ...DEFAULT_SETTINGS, templatesEnabled: true });
    ui.signatureTab.set('templates');
    expect(ui.signatureTab()).toBe('templates');

    settings.save({ ...DEFAULT_SETTINGS, templatesEnabled: false });
    expect(ui.signatureTab()).toBe('add');
  });

  it('keeps the chosen tab while templates stay on', () => {
    const settings = TestBed.inject(SettingsService);
    const ui = TestBed.inject(UiService);
    settings.save({ ...DEFAULT_SETTINGS, templatesEnabled: true });
    ui.signatureTab.set('templates');
    settings.save({ ...DEFAULT_SETTINGS, templatesEnabled: true, showRawPdfData: true });
    expect(ui.signatureTab()).toBe('templates');
  });
});
