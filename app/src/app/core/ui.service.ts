import { DOCUMENT } from '@angular/common';
import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { SettingsService } from './settings.service';

export type SectionId = 'metadata' | 'signatures' | 'revisions' | 'certificates';
export type SignatureTab = 'add' | 'templates';
export type SettingsTab = 'general' | 'signatures' | 'revisions' | 'certificates';

export const SECTION_PATHS: Record<SectionId, string> = {
  metadata: '/',
  signatures: '/signatures',
  revisions: '/versions',
  certificates: '/certificates',
};

export const SECTION_NAV: { id: SectionId; navId: string; label: string; icon: string }[] = [
  { id: 'metadata', navId: 'navBtnMetaData', label: 'Overview', icon: 'icon-info-circle' },
  { id: 'signatures', navId: 'navBtnSignatures', label: 'Signatures', icon: 'icon-pen' },
  { id: 'revisions', navId: 'navBtnRevisions', label: 'Versions', icon: 'icon-clock' },
  { id: 'certificates', navId: 'navBtnCertificates', label: 'Certificates', icon: 'icon-shield' },
];

export type SheetId = 'edit' | 'compare' | 'overview' | 'certificate' | 'certificateModify' | 'certificateTimeline';

/**
 * Cross-cutting UI state: which section is active, which modals and sheets
 * are open, and the body attributes styles.css keys off. Feature services own
 * the *content* of their modals/sheets; this owns only "is it open".
 */
@Injectable({ providedIn: 'root' })
export class UiService {
  private readonly document = inject(DOCUMENT);
  private readonly router = inject(Router);
  private readonly settings = inject(SettingsService);

  readonly activeSection = signal<SectionId>('metadata');
  readonly sectionNavOpen = signal(false);
  readonly openDropdown = signal<'upload' | 'download' | null>(null);

  readonly signatureTab = signal<SignatureTab>('add');

  // ---- Modals (content lives in the owning feature service) ----
  readonly extensionModalOpen = signal(false);
  readonly diagnosticsModalOpen = signal(false);
  readonly base64ModalOpen = signal(false);
  readonly settingsModalOpen = signal(false);
  readonly settingsTab = signal<SettingsTab>('general');
  readonly helpModalOpen = signal(false);
  readonly closeDocumentModalOpen = signal(false);
  readonly saveAsModalOpen = signal(false);
  readonly removeFieldName = signal<string | null>(null);
  readonly xmpRaw = signal<string | null>(null);
  readonly fieldInfoKey = signal<string | null>(null);
  /** Bumped every time Settings opens, so its form re-syncs from storage. */
  readonly settingsOpenCount = signal(0);

  // ---- Sheets (slide over the right-hand column; one at a time) ----
  readonly sheets = {
    edit: signal(false),
    compare: signal(false),
    overview: signal(false),
    certificate: signal(false),
    certificateModify: signal(false),
    certificateTimeline: signal(false),
  } satisfies Record<SheetId, ReturnType<typeof signal<boolean>>>;

  readonly anySheetOpen = computed(() => Object.values(this.sheets).some((s) => s()));

  /** Set while the demo tour runs: it owns Escape and the arrow keys. */
  readonly tourActive = signal(false);


  constructor() {
    effect(() => {
      this.document.body.dataset['activeSection'] = this.activeSection();
    });
    effect(() => {
      this.document.body.classList.toggle('edit-sheet-open', this.anySheetOpen());
    });
    // The Templates tab disappears with the setting -- don't strand the panel on it.
    effect(() => {
      if (!this.settings.effective().templatesEnabled && this.signatureTab() !== 'add') this.signatureTab.set('add');
    });
  }

  goToSection(section: SectionId): Promise<boolean> {
    this.sectionNavOpen.set(false);
    if (this.activeSection() === section && this.router.url.split(/[?#]/)[0] === SECTION_PATHS[section]) {
      return Promise.resolve(true);
    }
    return this.router.navigateByUrl(SECTION_PATHS[section]);
  }

  openSheet(id: SheetId): void {
    this.sheets[id].set(true);
  }

  closeSheet(id: SheetId): void {
    this.sheets[id].set(false);
  }

  isSheetOpen(id: SheetId): boolean {
    return this.sheets[id]();
  }

  openSettings(tab?: string): void {
    const byName: Record<string, SettingsTab> = {
      general: 'general',
      signatures: 'signatures',
      templates: 'signatures',
      revisions: 'revisions',
      certificates: 'certificates',
    };
    this.settingsTab.set((tab && byName[tab]) || 'general');
    this.settings.refresh();
    this.settingsOpenCount.update((n) => n + 1);
    this.settingsModalOpen.set(true);
  }

  /** True while any `.modal-backdrop.is-open` exists (sheets defer Escape to modals). */
  anyModalOpen(): boolean {
    return !!this.document.querySelector('.modal-backdrop.is-open');
  }
}
