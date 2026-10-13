import { DOCUMENT } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRouteSnapshot, NavigationEnd, Router, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs';
import { UiService, type SectionId } from './core/ui.service';
import { CertificatesStore } from './features/certificates/certificates.store';
import { OverviewStore } from './features/overview/overview.store';
import { ShareService } from './features/share/share.service';
import { SignaturesStore } from './features/signatures/signatures.store';
import { TemplatesStore } from './features/signatures/templates.store';
import { VersionsStore } from './features/versions/versions.store';
import { ExportService } from './features/export/export.service';
import { TourService } from './features/tour/tour.service';
import { Footer } from './shell/footer/footer';
import { Modals } from './shell/modals/modals';
import { NotificationStack } from './shell/notification-stack/notification-stack';
import { PendingChangesBar } from './shell/pending-changes-bar/pending-changes-bar';
import { Sheets } from './shell/sheets/sheets';
import { Topbar } from './shell/topbar/topbar';
import { TourOverlay } from './shell/tour-overlay/tour-overlay';
import { Viewer } from './shell/viewer/viewer';

const SHARE_SESSION_ID = /^[a-zA-Z0-9_-]{8,32}$/;

/**
 * The page: viewer on the left, the routed section on the right with its
 * sliding sheets, the top bar, toasts, the tour overlay and every modal.
 * Also the one place that reacts to section changes and global keys.
 */
@Component({
  selector: 'app-root',
  imports: [RouterOutlet, NotificationStack, TourOverlay, PendingChangesBar, Topbar, Viewer, Footer, Modals, Sheets],
  template: `
    <div appNotificationStack></div>
    <app-tour-overlay />
    <div appPendingChangesBar></div>
    <header appTopbar></header>

    @defer (on idle) {
      <app-modals />
    }

    <div class="app-shell">
      <section appViewer></section>

      <div class="section-column">
        <div class="section-scroll">
          <div class="back-to-document" id="backToDocumentBar" [hidden]="!overview.diagnosticOrigin()">
            <button
              type="button"
              class="btn btn-ghost btn-small"
              id="btnBackToFinding"
              [title]="overview.diagnosticOrigin() ? 'Back to “' + overview.diagnosticOrigin()?.label + '” in the document' : ''"
              (click)="overview.backToFinding()"
            >
              <span aria-hidden="true">←</span> Back to document
            </button>
          </div>
          <router-outlet />
        </div>

        @defer (on idle) {
          <app-sheets />
        }
      </div>
    </div>

    <footer appFooter></footer>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:keydown)': 'onKeydown($event)',
    '(document:click)': 'onDocumentClick($event)',
  },
})
export class App {
  private readonly router = inject(Router);
  private readonly document = inject(DOCUMENT);
  protected readonly ui = inject(UiService);
  protected readonly overview = inject(OverviewStore);
  private readonly signatures = inject(SignaturesStore);
  private readonly templates = inject(TemplatesStore);
  private readonly versions = inject(VersionsStore);
  private readonly certificates = inject(CertificatesStore);
  private readonly share = inject(ShareService);
  private readonly exporter = inject(ExportService);
  private readonly tour = inject(TourService);

  private previousSection: SectionId | null = null;
  private receivedShare: string | null = null;

  constructor() {
    // The share key lives in ?k= / #k=; grab it before any navigation drops it.
    this.share.captureUrlKey();

    this.router.events
      .pipe(
        filter((e): e is NavigationEnd => e instanceof NavigationEnd),
        takeUntilDestroyed(inject(DestroyRef)),
      )
      .subscribe(() => this.onNavigated(this.leafSnapshot()));
  }

  private leafSnapshot(): ActivatedRouteSnapshot {
    let snapshot = this.router.routerState.snapshot.root;
    while (snapshot.firstChild) snapshot = snapshot.firstChild;
    return snapshot;
  }

  /** What leaving one section and entering another does to the others' state. */
  private onNavigated(snapshot: ActivatedRouteSnapshot): void {
    const target = (snapshot.data['section'] as SectionId | undefined) ?? 'metadata';
    const previous = this.previousSection;
    this.previousSection = target;
    this.ui.activeSection.set(target);
    this.ui.sectionNavOpen.set(false);

    if (target !== 'signatures' && this.signatures.activeFieldUid()) this.signatures.deselect();
    if (previous === 'revisions' && target !== 'revisions') this.versions.suspend();
    if (target !== 'metadata') this.overview.closeSheet();
    else this.overview.clearDiagnosticOrigin();
    if (target !== 'certificates') {
      this.certificates.closeCertificateSheet();
      this.certificates.closeModifySheet();
      this.certificates.closeTimelineSheet();
    }
    if (target === 'metadata') void this.overview.loadIfNeeded();
    if (target === 'revisions') {
      void this.versions.loadIfNeeded();
      void this.versions.resume();
    }
    if (target === 'certificates') void this.certificates.loadIfNeeded();

    // /share/:sessionId -- the recipient's side of a share link.
    if (snapshot.data['share']) {
      const sessionId = snapshot.paramMap.get('sessionId') ?? '';
      if (SHARE_SESSION_ID.test(sessionId) && this.receivedShare !== sessionId) {
        this.receivedShare = sessionId;
        void this.share.startReceiving(sessionId);
      }
    }
  }

  protected onDocumentClick(event: MouseEvent): void {
    const target = event.target instanceof Element ? event.target : null;
    if (this.ui.openDropdown() && !target?.closest('.dropdown.is-open')) this.ui.openDropdown.set(null);
    if (this.ui.sectionNavOpen() && !target?.closest('.section-nav-shell')) this.ui.sectionNavOpen.set(false);
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      this.onEscape();
      return;
    }
    this.onUndoShortcut(event);
  }

  /** Ctrl/Cmd+Z undo, Ctrl/Cmd+Shift+Z redo -- in Signatures only. */
  private onUndoShortcut(event: KeyboardEvent): void {
    if (this.ui.activeSection() !== 'signatures') return;
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'z') return;
    const tag = this.document.activeElement?.tagName;
    const isTextInput = tag === 'INPUT' || tag === 'TEXTAREA';
    if (isTextInput && !event.shiftKey) return; // plain Ctrl+Z keeps editing text normally
    event.preventDefault();
    void (event.shiftKey ? this.signatures.redo() : this.signatures.undo());
  }

  /**
   * Escape closes the innermost thing: dropdowns always, then the topmost
   * open modal; sheets only once no modal is open. The tour owns Escape
   * while it runs (see TourOverlay).
   */
  private onEscape(): void {
    this.ui.openDropdown.set(null);
    this.ui.sectionNavOpen.set(false);
    if (this.ui.tourActive()) return;

    const ui = this.ui;
    const t = this.templates;
    const modalClosers: [() => boolean, () => void][] = [
      [() => !!t.importModal(), () => t.closeImportModal()],
      [() => !!t.moveModal(), () => t.closeMoveModal()],
      [() => !!t.removeItem(), () => t.closeRemoveItemModal()],
      [() => !!t.deleteTemplateId(), () => t.closeDeleteModal()],
      [() => t.nameModal().open, () => t.closeNameModal()],
      [() => !!t.cleanup(), () => t.closeCleanup()],
      [() => ui.fieldInfoKey() !== null, () => ui.fieldInfoKey.set(null)],
      [() => !!this.versions.rawModal(), () => this.versions.closeRawObject()],
      [() => ui.xmpRaw() !== null, () => ui.xmpRaw.set(null)],
      [() => ui.removeFieldName() !== null, () => ui.removeFieldName.set(null)],
      [() => !!this.tour.demoReplacePending(), () => this.tour.cancelDemoReplace()],
      [() => ui.closeDocumentModalOpen(), () => ui.closeDocumentModalOpen.set(false)],
      [() => ui.saveAsModalOpen(), () => this.exporter.closeSaveAs()],
      [() => ui.base64ModalOpen(), () => ui.base64ModalOpen.set(false)],
      [() => ui.settingsModalOpen(), () => ui.settingsModalOpen.set(false)],
      [() => ui.helpModalOpen(), () => ui.helpModalOpen.set(false)],
      [() => ui.diagnosticsModalOpen(), () => ui.diagnosticsModalOpen.set(false)],
      [() => ui.extensionModalOpen(), () => ui.extensionModalOpen.set(false)],
    ];
    const open = modalClosers.find(([isOpen]) => isOpen());
    if (open) {
      open[1]();
      return;
    }
    // The share dialog keeps running transfers -- it closes from its own buttons only.
    if (this.ui.anyModalOpen()) return;

    if (ui.sheets.edit()) this.signatures.deselect();
    else if (ui.sheets.overview()) this.overview.closeSheet();
    else if (ui.sheets.compare()) this.versions.closeCompareSheet();
    else if (ui.sheets.certificate()) this.certificates.closeCertificateSheet();
    else if (ui.sheets.certificateModify()) this.certificates.closeModifySheet();
    else if (ui.sheets.certificateTimeline()) this.certificates.closeTimelineSheet();
  }
}
