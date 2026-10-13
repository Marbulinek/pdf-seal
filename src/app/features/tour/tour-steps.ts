import type { Placement } from '../../../../lib/DemoTour';
import type { AppSettings } from '../../core/settings.service';

export type TourChapter = 'intro' | 'signatures' | 'templates' | 'metadata' | 'revisions' | 'certificates' | 'settings' | 'finish';

/** The actions a step's `enter` hook can take -- implemented by TourService. */
export interface TourActions {
  goToSection(navId: 'navBtnMetaData' | 'navBtnSignatures' | 'navBtnRevisions' | 'navBtnCertificates'): Promise<void>;
  deselectField(): void;
  goToPage(num: number): Promise<void>;
  selectField(name: string): Promise<void>;
  openFieldDetails(): void;
  setSettingsOverride(patch: Partial<AppSettings>): void;
  stageDemoField(): Promise<void>;
  undoDemoField(): void;
  showTemplatesTab(): void;
  captureDemoTemplate(): void;
  openOverview(): Promise<void>;
  inspectProviderSignature(): Promise<void>;
  showVersionTimeline(): Promise<void>;
  compareFirstTwoVersions(): Promise<void>;
  switchDiffTab(tab: 'details' | 'visual'): void;
  openCertificateReport(): Promise<void>;
  openProviderCertificate(): Promise<void>;
  closeCertificateSheet(): void;
  openSettings(tab: 'general'): void;
  setSettingsTab(tab: 'signatures' | 'revisions' | 'certificates'): void;
  toggleSettingsDraft(key: keyof AppSettings, value: boolean): void;
  closeSettings(): void;
}

export interface TourStep {
  id: string;
  chapter: TourChapter;
  /** CSS selector of the element to spotlight, or null for a centred card. */
  target: string | null;
  placement: Placement;
  title: string;
  body: string;
  enter(actions: TourActions): Promise<void>;
}

/** 31 steps across 8 chapters, run against the bundled sample agreement. */
export function buildTourSteps(): TourStep[] {
  return [
    // Chapter: intro
    {
      id: 'intro-welcome',
      chapter: 'intro',
      target: null,
      placement: 'bottom',
      title: 'Welcome to pdf-seal',
      body: "This is the bundled sample document — a real, three-revision, signed PDF. Click Next and we'll walk through what pdf-seal can do with it. You can still click around at any step.",
      enter: async (a) => {
        await a.goToSection('navBtnSignatures');
        a.deselectField();
      },
    },
    {
      id: 'intro-toolbar',
      chapter: 'intro',
      target: '.viewer-toolbar',
      placement: 'bottom',
      title: 'The viewer toolbar',
      body: 'Move between pages, zoom, and pan the document here.',
      enter: async (a) => {
        await a.goToSection('navBtnSignatures');
      },
    },
    {
      id: 'intro-nav',
      chapter: 'intro',
      target: '#sectionNav',
      placement: 'bottom',
      title: 'Section tabs',
      body: 'Overview, Signatures, Versions, and Certificates — everything below is organized under one of these four sections.',
      enter: async () => {},
    },
    // Chapter: signatures
    {
      id: 'sig-overlays',
      chapter: 'signatures',
      target: '#pdfContainer',
      placement: 'left',
      title: 'Signature fields on the page',
      body: 'Fields are drawn right on the page. Drag one to move it, or use its corner grip to resize — this document has two signature fields on page 2, plus two text fields shown read-only — PDF Seal edits signature fields only.',
      enter: async (a) => {
        await a.goToSection('navBtnSignatures');
        a.deselectField();
        await a.goToPage(2);
      },
    },
    {
      id: 'sig-editsheet',
      chapter: 'signatures',
      target: '#editSheet',
      placement: 'left',
      title: 'Editing a field',
      body: 'Selecting a field opens this panel: rename it, adjust its exact position and size, or mark it required. "Field Details" below shows the raw PDF properties behind it.',
      enter: async (a) => {
        await a.goToSection('navBtnSignatures');
        a.setSettingsOverride({ showRawPdfData: true });
        await a.selectField('Client_Signature');
        a.openFieldDetails();
      },
    },
    {
      id: 'sig-signednotice',
      chapter: 'signatures',
      target: '#editSignedNotice',
      placement: 'left',
      title: 'A field that is already signed',
      body: 'Provider_Signature carries a real signature, so pdf-seal locks its position and size — moving or resizing it would invalidate the bytes the signature covers.',
      enter: async (a) => {
        await a.selectField('Provider_Signature');
      },
    },
    {
      id: 'sig-add',
      chapter: 'signatures',
      target: '#sigTabPanelAdd',
      placement: 'right',
      title: 'Adding a new field',
      body: 'Name a field, pick a size, then click to drop it on the page. Watch: we\'ll stage a demo "Witness_Signature" field the same way.',
      enter: async (a) => {
        await a.stageDemoField();
      },
    },
    {
      id: 'sig-pending',
      chapter: 'signatures',
      target: '#pendingChangesBar',
      placement: 'top',
      title: 'Pending changes',
      body: 'New and edited fields stage here first. Discard throws them away; Apply changes re-saves the document with them baked in. (The tour never clicks Apply here — doing so would re-save this already-signed file and invalidate its signature. Try it yourself outside the tour.)',
      enter: async () => {},
    },
    {
      id: 'sig-history',
      chapter: 'signatures',
      target: '#historyStrip',
      placement: 'bottom',
      title: 'Undo / redo',
      body: 'Every staged change can be undone or redone — including adding a field. Watch the demo Witness_Signature field disappear.',
      enter: async (a) => {
        a.undoDemoField();
      },
    },
    // Chapter: templates
    {
      id: 'tpl-tabs',
      chapter: 'templates',
      target: '#sigTabs',
      placement: 'right',
      title: 'Signature templates',
      body: "Turned on here just for the tour — Templates saves a field's layout for reuse across documents. Turn it on for real in Settings.",
      enter: async (a) => {
        a.setSettingsOverride({ templatesEnabled: true });
        a.showTemplatesTab();
      },
    },
    {
      id: 'tpl-grip',
      chapter: 'templates',
      target: '.field-overlay[data-field-name="Client_Signature"] .template-save-handle',
      placement: 'top',
      title: 'Storing a field in a template',
      body: "Select a field on the page (or just hover it) and this small handle appears in its corner. Grab it and drag it onto the Signature Templates panel to save that field's layout for reuse.",
      enter: async (a) => {
        await a.goToPage(2);
        await a.selectField('Client_Signature');
      },
    },
    {
      id: 'tpl-dropzone',
      chapter: 'templates',
      target: '#templateDropzone',
      placement: 'right',
      title: 'Captured',
      body: 'Drop the handle here to save it — that\'s exactly what just happened for Client_Signature, and we did the same for Client_Name, both captured into a "Demo template" for you.',
      enter: async (a) => {
        a.captureDemoTemplate();
      },
    },
    {
      id: 'tpl-mode',
      chapter: 'templates',
      target: '#templateModeTabs',
      placement: 'right',
      title: 'Placing a template',
      body: 'Place items back one at a time by hand, or automatically drop every item from a template onto the document in one go.',
      enter: async () => {},
    },
    {
      id: 'tpl-settings',
      chapter: 'templates',
      target: '#btnOpenTemplateSettings',
      placement: 'bottom',
      title: 'Backup & restore',
      body: 'Templates live only in this browser. Download them as a JSON file to keep a copy, and load one back in on another computer.',
      enter: async () => {},
    },
    // Chapter: metadata
    {
      id: 'meta-overview',
      chapter: 'metadata',
      target: '#metaOverview',
      placement: 'right',
      title: 'Document overview',
      body: "What this PDF is and what's on it: a summary, at-a-glance badges, and a list of its signatures, stamps, form fields, links and comments. Hover a row to find it on the page.",
      enter: async (a) => {
        await a.openOverview();
      },
    },
    {
      id: 'meta-inspect',
      chapter: 'metadata',
      target: '.field-overlay[data-field-name="Provider_Signature"]',
      placement: 'bottom',
      title: 'Inspect an object',
      body: 'While Overview is open, objects are outlined on the page. Click one — or its row in the list — to see who signed, when, and what the signature covers.',
      enter: async (a) => {
        await a.inspectProviderSignature();
      },
    },
    // Chapter: revisions
    {
      id: 'rev-timeline',
      chapter: 'revisions',
      target: '#revisionsTimeline',
      placement: 'right',
      title: 'Version history',
      body: "Every saved version of this file, oldest first, badged by how it was produced. This sample has three, all imported from the file's own embedded history: the original terms, a clause change plus new fields, and the signed final version — each a full rewrite of the PDF, not an appended update.",
      enter: async (a) => {
        await a.showVersionTimeline();
      },
    },
    {
      id: 'rev-compare',
      chapter: 'revisions',
      target: '#revisionsCompareSheet',
      placement: 'left',
      title: 'Comparing versions',
      body: "Pick any two versions and compare them. Here's version 1 against version 2 — the turnaround clause changed, and four fields were added.",
      enter: async (a) => {
        await a.compareFirstTwoVersions();
      },
    },
    {
      id: 'rev-details',
      chapter: 'revisions',
      target: '#revisionsDiffResults',
      placement: 'left',
      title: 'Field-by-field details',
      body: 'Exactly which fields and metadata changed, in detail.',
      enter: async (a) => {
        a.switchDiffTab('details');
      },
    },
    {
      id: 'rev-visual',
      chapter: 'revisions',
      target: '#visualDiffPanel',
      placement: 'left',
      title: 'Visual diff',
      body: 'And the changed passage highlighted right on the page — the "30 days" clause became "14 days".',
      enter: async (a) => {
        a.switchDiffTab('visual');
      },
    },
    // Chapter: certificates
    {
      id: 'cert-summary',
      chapter: 'certificates',
      target: '#certificatesSummaryPanel',
      placement: 'right',
      title: 'Certificate report',
      body: "Every signature in the file, its integrity, and the certificate chain behind it. The banner explains exactly what this app did and didn't verify.",
      enter: async (a) => {
        await a.openCertificateReport();
      },
    },
    {
      id: 'cert-signatures',
      chapter: 'certificates',
      target: '#certificatesSignaturesPanel',
      placement: 'right',
      title: 'Signatures in this document',
      body: 'Provider_Signature is signed and verifies cleanly. Client_Signature is still an empty, required field — waiting to be signed.',
      enter: async () => {},
    },
    {
      id: 'cert-sheet',
      chapter: 'certificates',
      target: '#certificateSheet',
      placement: 'left',
      title: 'Certificate chain detail',
      body: "Alex Morgan's signing certificate, up through the PDF Seal Demo Signing CA to the PDF Seal Demo Root CA.",
      enter: async (a) => {
        await a.openProviderCertificate();
      },
    },
    {
      id: 'cert-tools',
      chapter: 'certificates',
      target: null,
      placement: 'bottom',
      title: 'Optional certificate tools',
      body: 'Turned on in Settings when you need them: a standalone scratchpad for inspecting any certificate, trust simulation against a root CA bundle you supply (try the demo root CA from the Help docs), and modification tools for building test documents.',
      enter: async (a) => {
        a.setSettingsOverride({ certificateScratchpadEnabled: true, trustSimulationEnabled: true, certificateModifyEnabled: true });
      },
    },
    // Chapter: settings
    {
      id: 'settings-gear',
      chapter: 'settings',
      target: '#btnOpenSettings',
      placement: 'bottom',
      title: 'Settings',
      body: 'Click the gear icon any time to open Settings and turn optional panels on or off.',
      enter: async (a) => {
        a.closeCertificateSheet();
        await a.goToSection('navBtnSignatures');
      },
    },
    {
      id: 'settings-general',
      chapter: 'settings',
      target: '#settingsTabPanelGeneral',
      placement: 'left',
      title: 'Settings: General',
      body: 'These toggles turn optional panels on and off for real (unlike this tour\'s temporary previews) — nothing here takes effect until you hit Save. "Show advanced PDF raw data" exposes raw PDF objects wherever they\'re relevant: Signatures, Versions, and Certificates.',
      enter: async (a) => {
        a.closeCertificateSheet();
        a.openSettings('general');
        a.toggleSettingsDraft('showRawPdfData', true);
      },
    },
    {
      id: 'settings-signatures',
      chapter: 'settings',
      target: '#settingsTabPanelSignatures',
      placement: 'left',
      title: 'Settings: Signatures',
      body: '"Enable signature templates" turns on the Templates tab and panel for good, the same one this tour switched on temporarily earlier. Backup and restore your templates as a JSON file right below it.',
      enter: async (a) => {
        a.setSettingsTab('signatures');
        a.toggleSettingsDraft('templatesEnabled', true);
      },
    },
    {
      id: 'settings-revisions',
      chapter: 'settings',
      target: '#settingsTabPanelRevisions',
      placement: 'left',
      title: 'Settings: Versions',
      body: '"Include versions when exporting / sharing document" bundles your locally-stored version history into the file whenever you download or share it.',
      enter: async (a) => {
        a.setSettingsTab('revisions');
        a.toggleSettingsDraft('includeRevisionHistoryByDefault', true);
      },
    },
    {
      id: 'settings-certificates',
      chapter: 'settings',
      target: '#settingsTabPanelCertificates',
      placement: 'left',
      title: 'Settings: Certificates',
      body: 'Three opt-in tools: certificate modification for building test documents, a standalone scratchpad for inspecting any certificate on its own, and trust simulation against a root CA bundle you supply.',
      enter: async (a) => {
        a.setSettingsTab('certificates');
        a.toggleSettingsDraft('certificateModifyEnabled', true);
        a.toggleSettingsDraft('certificateScratchpadEnabled', true);
        a.toggleSettingsDraft('trustSimulationEnabled', true);
      },
    },
    // Chapter: finish
    {
      id: 'finish-share',
      chapter: 'finish',
      target: '.topbar-row-tertiary',
      placement: 'bottom',
      title: 'Share & export',
      body: 'Download the PDF, copy it as Base64, or share it peer-to-peer with an encrypted, expiring link.',
      enter: async (a) => {
        a.closeSettings();
        a.closeCertificateSheet();
        await a.goToSection('navBtnSignatures');
      },
    },
    {
      id: 'finish-end',
      chapter: 'finish',
      target: '#btnOpenHelp',
      placement: 'bottom',
      title: "That's the tour",
      body: 'Revisit any of this from the Help modal any time, or open Settings to turn the optional panels on for good. The sample document stays loaded so you can keep exploring.',
      enter: async () => {},
    },
  ];
}
