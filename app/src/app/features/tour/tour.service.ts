import { DOCUMENT } from '@angular/common';
import { Injectable, inject, signal } from '@angular/core';
import { chapterStartIndex, findStepIndex, spotlightRect, type Rect } from './demo-tour';
import { DocumentService } from '../../core/document.service';
import { DocumentStore } from '../../core/document.store';
import { SettingsService, type AppSettings } from '../../core/settings.service';
import { SECTION_NAV, UiService } from '../../core/ui.service';
import { waitFor } from '../../core/util/dom';
import { ViewerService } from '../../core/viewer.service';
import { CertificatesStore } from '../certificates/certificates.store';
import { OverviewStore } from '../overview/overview.store';
import { SignaturesStore } from '../signatures/signatures.store';
import { TemplatesStore } from '../signatures/templates.store';
import { VersionsStore } from '../versions/versions.store';
import { buildTourSteps, type TourActions, type TourStep } from './tour-steps';

/** Spotlight pulse on the destination nav tab before a section switch. */
const TOUR_SECTION_FLASH_MS = 700;

type NavId = Parameters<TourActions['goToSection']>[0];

/**
 * The guided demo tour: loads the bundled, genuinely signed sample agreement
 * and walks through every section. Temporary panel toggles go through the
 * settings demo override and a template sandbox, so nothing it does is saved.
 */
@Injectable({ providedIn: 'root' })
export class TourService implements TourActions {
  private readonly document = inject(DOCUMENT);
  private readonly doc = inject(DocumentStore);
  private readonly documents = inject(DocumentService);
  private readonly settings = inject(SettingsService);
  private readonly ui = inject(UiService);
  private readonly viewer = inject(ViewerService);
  private readonly signatures = inject(SignaturesStore);
  private readonly templates = inject(TemplatesStore);
  private readonly overview = inject(OverviewStore);
  private readonly versions = inject(VersionsStore);
  private readonly certificates = inject(CertificatesStore);

  readonly steps = signal<TourStep[]>([]);
  readonly index = signal(0);
  readonly title = signal('');
  readonly text = signal('');
  readonly spinnerVisible = signal(false);
  readonly switching = signal(false);
  /** A one-off spotlight (the nav tab being switched to), overriding the step target. */
  readonly flashSpotlight = signal<Rect | null>(null);
  /** Nav button pulsed during a section switch. */
  readonly flashNavId = signal<string | null>(null);
  /** Bumped whenever the popover should re-measure/re-position. */
  readonly positionTick = signal(0);

  /** Pending "replace the open document?" confirmation: chapter to start, or null to just load. */
  readonly demoReplacePending = signal<{ chapter: string | null } | null>(null);

  private stepToken = 0;
  private demoSampleFile: File | null = null;
  private demoTemplateId: string | null = null;

  // ---------------------------------------------------------------------
  // Sample document
  // ---------------------------------------------------------------------

  private async loadDemoSampleDocument(): Promise<File> {
    if (this.demoSampleFile && this.doc.activeFile() === this.demoSampleFile && this.signatures.pendingCount() === 0) {
      return this.demoSampleFile;
    }
    const res = await fetch('/assets/demo/pdf-seal-sample.pdf');
    const blob = await res.blob();
    const file = new File([blob], 'pdf-seal-sample.pdf', { type: 'application/pdf' });
    await this.documents.processNewFile(file);
    this.demoSampleFile = file;
    return file;
  }

  private async performDemoSampleLoad(chapter: string | null): Promise<void> {
    await this.loadDemoSampleDocument();
    if (chapter) this.begin(chapter);
  }

  /** Loads the sample (asking first if it would replace another document). */
  requestDemoSampleLoad(startTourChapter: string | null): void {
    if (this.doc.activeFile() && this.doc.activeFile() !== this.demoSampleFile) {
      this.demoReplacePending.set({ chapter: startTourChapter });
      return;
    }
    this.performDemoSampleLoad(startTourChapter);
  }

  start(chapterId: string | null): void {
    this.requestDemoSampleLoad(chapterId || 'intro');
  }

  confirmDemoReplace(): void {
    const pending = this.demoReplacePending();
    this.demoReplacePending.set(null);
    this.performDemoSampleLoad(pending?.chapter ?? null);
  }

  cancelDemoReplace(): void {
    this.demoReplacePending.set(null);
  }

  // ---------------------------------------------------------------------
  // Engine
  // ---------------------------------------------------------------------

  currentStep(): TourStep | null {
    return this.steps()[this.index()] ?? null;
  }

  private async goToStep(index: number): Promise<void> {
    const step = this.steps()[index];
    if (!step) return;
    this.index.set(index);
    const token = ++this.stepToken;
    this.title.set(step.title);
    this.text.set(step.body);
    this.spinnerVisible.set(true);
    this.positionTick.update((n) => n + 1);
    try {
      await step.enter(this);
    } catch {
      // A step's demo action failing shouldn't strand the tour.
    }
    if (token !== this.stepToken || !this.ui.tourActive()) return; // superseded
    this.spinnerVisible.set(false);
    this.positionTick.update((n) => n + 1);
  }

  begin(chapterId: string): void {
    this.steps.set(buildTourSteps());
    this.ui.tourActive.set(true);
    const startIndex = chapterStartIndex(this.steps(), chapterId);
    this.goToStep(startIndex >= 0 ? startIndex : 0);
  }

  advance(): void {
    if (this.index() >= this.steps().length - 1) {
      this.exit();
      return;
    }
    this.goToStep(findStepIndex(this.steps(), this.index(), 'next'));
  }

  back(): void {
    this.goToStep(findStepIndex(this.steps(), this.index(), 'back'));
  }

  exit(): void {
    if (!this.ui.tourActive()) return;
    this.ui.tourActive.set(false);
    this.stepToken++;
    this.versions.exitDiffViewMode();
    this.versions.closeCompareSheet();
    this.certificates.closeCertificateSheet();
    this.certificates.closeTimelineSheet();
    this.ui.settingsModalOpen.set(false);
    this.signatures.deselect();
    this.settings.clearDemoOverride();
    this.templates.restoreSandbox();
    this.demoTemplateId = null;
    this.goToSection('navBtnMetaData');
  }

  // ---------------------------------------------------------------------
  // TourActions -- what the steps' enter hooks do
  // ---------------------------------------------------------------------

  /**
   * Switches section, but not silently: spotlights and pulses the destination
   * tab first, with the popover saying where it's going.
   */
  async goToSection(navId: NavId): Promise<void> {
    const nav = SECTION_NAV.find((n) => n.navId === navId);
    if (!nav || this.ui.activeSection() === nav.id) return;
    const btn = this.document.getElementById(navId);
    if (btn && this.ui.tourActive()) {
      const rect = btn.getBoundingClientRect();
      this.flashSpotlight.set(
        spotlightRect({ top: rect.top, left: rect.left, width: rect.width, height: rect.height }, 6, {
          width: window.innerWidth,
          height: window.innerHeight,
        }),
      );
      this.flashNavId.set(navId);
      const previousTitle = this.title();
      const previousText = this.text();
      this.title.set(`Switching to ${nav.label}…`);
      this.text.set(`Jumping to the ${nav.label} section of the app.`);
      this.switching.set(true);
      const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      if (!reducedMotion) await new Promise((resolve) => setTimeout(resolve, TOUR_SECTION_FLASH_MS));
      this.flashNavId.set(null);
      this.flashSpotlight.set(null);
      this.switching.set(false);
      this.title.set(previousTitle);
      this.text.set(previousText);
    }
    await this.ui.goToSection(nav.id);
    await this.viewer.afterRender();
  }

  deselectField(): void {
    this.signatures.deselect();
  }

  async goToPage(num: number): Promise<void> {
    if (this.viewer.pageNum() === num) return;
    await this.viewer.goToPage(num);
  }

  async selectField(name: string): Promise<void> {
    const field = this.doc.fields().find((f) => f.name === name);
    if (!field) return;
    if (typeof field.page === 'number' && field.page + 1 !== this.viewer.pageNum()) await this.viewer.goToPage(field.page + 1);
    this.signatures.select(field.uid);
  }

  openFieldDetails(): void {
    this.signatures.setFieldDetailsOpen(true);
  }

  setSettingsOverride(patch: Partial<AppSettings>): void {
    this.settings.setDemoOverride(patch);
  }

  async stageDemoField(): Promise<void> {
    this.signatures.deselect();
    this.ui.signatureTab.set('add');
    this.signatures.setAddForm({ addName: 'Witness_Signature' });
    await this.goToPage(2);
    await this.viewer.afterRender();
    const canvas = this.viewer.canvasSize();
    if (canvas.width && canvas.height && !this.doc.fields().some((f) => f.name === 'Witness_Signature')) {
      this.signatures.placeFieldAt(canvas.width * 0.72, canvas.height * 0.14);
    }
  }

  undoDemoField(): void {
    if (this.doc.fields().some((f) => f.name === 'Witness_Signature')) this.signatures.undo();
  }

  private ensureDemoTemplate(): string {
    this.templates.activateSandbox();
    this.demoTemplateId = this.templates.ensureDemoTemplate(this.demoTemplateId);
    return this.demoTemplateId;
  }

  showTemplatesTab(): void {
    this.ensureDemoTemplate();
    this.ui.signatureTab.set('templates');
  }

  captureDemoTemplate(): void {
    const templateId = this.ensureDemoTemplate();
    const clientSig = this.doc.fields().find((f) => f.name === 'Client_Signature') ?? null;
    const clientName = this.doc.fields().find((f) => f.name === 'Client_Name') ?? null;
    if (clientSig) this.templates.saveFieldToTemplate(clientSig, templateId);
    if (clientName) this.templates.saveFieldToTemplate(clientName, templateId);
  }

  async openOverview(): Promise<void> {
    await this.goToSection('navBtnMetaData');
    this.overview.closeSheet();
    await this.overview.loadIfNeeded();
  }

  async inspectProviderSignature(): Promise<void> {
    await this.goToSection('navBtnMetaData');
    await this.overview.loadIfNeeded();
    await this.goToPage(2);
    this.overview.openSheet('signature', 'Provider_Signature');
  }

  async showVersionTimeline(): Promise<void> {
    await this.goToSection('navBtnRevisions');
    // The sample's three versions come from its embedded chain -- wait for
    // hydration, or the panel can show just the current version.
    await this.documents.ensureRevisionHydration();
    await this.versions.loadIfNeeded();
    await waitFor(() => !!this.versions.revisions()?.length && !this.versions.loading());
    if (!this.versions.expanded().includes(3)) await this.versions.toggleCard(3);
  }

  async compareFirstTwoVersions(): Promise<void> {
    await this.versions.runQuickDiff(1, 2, 'overview');
    await waitFor(() => this.versions.diff() !== null);
  }

  switchDiffTab(tab: 'details' | 'visual'): void {
    this.versions.switchTab(tab);
  }

  async openCertificateReport(): Promise<void> {
    this.versions.exitDiffViewMode();
    this.versions.closeCompareSheet();
    await this.goToSection('navBtnCertificates');
    await this.certificates.loadIfNeeded();
    await waitFor(() => this.certificates.report() !== null);
  }

  async openProviderCertificate(): Promise<void> {
    const chain = this.certificates.report()?.chains.find((c) => c.signatureFieldName === 'Provider_Signature');
    const leafId = chain?.certificateIds?.[0] ?? null;
    if (!leafId) return;
    this.certificates.openCertificateSheet(leafId, 'validation');
    await waitFor(() => this.ui.sheets.certificate());
  }

  closeCertificateSheet(): void {
    this.certificates.closeCertificateSheet();
  }

  openSettings(tab: 'general'): void {
    this.ui.openSettings(tab);
  }

  setSettingsTab(tab: 'signatures' | 'revisions' | 'certificates'): void {
    this.ui.settingsTab.set(tab);
  }

  /** Visually flips a Settings checkbox -- the draft is re-synced from storage on the next real open. */
  toggleSettingsDraft(key: keyof AppSettings, value: boolean): void {
    this.settings.setDraft(key, value);
  }

  closeSettings(): void {
    this.ui.settingsModalOpen.set(false);
  }
}
