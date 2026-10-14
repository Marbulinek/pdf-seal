import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { NotificationService } from '../../core/notification.service';
import { SettingsService, type AppSettings } from '../../core/settings.service';
import { UiService, type SettingsTab } from '../../core/ui.service';
import { plural } from '../../core/util/format';
import { TemplatesStore } from '../../features/signatures/templates.store';
import { isBackdropClick } from './simple-modals';

interface SettingsToggle {
  key: keyof AppSettings;
  id: string;
  label: string;
  hint: string;
}

const TABS: { id: SettingsTab; btnId: string; panelId: string; label: string }[] = [
  { id: 'general', btnId: 'settingsTabBtnGeneral', panelId: 'settingsTabPanelGeneral', label: 'General' },
  { id: 'signatures', btnId: 'settingsTabBtnSignatures', panelId: 'settingsTabPanelSignatures', label: 'Signatures' },
  { id: 'revisions', btnId: 'settingsTabBtnRevisions', panelId: 'settingsTabPanelRevisions', label: 'Versions' },
  { id: 'certificates', btnId: 'settingsTabBtnCertificates', panelId: 'settingsTabPanelCertificates', label: 'Certificates' },
];

const RAW_DATA: SettingsToggle = {
  key: 'showRawPdfData',
  id: 'settingsShowRawData',
  label: 'Show advanced PDF raw data',
  hint: 'If enabled, shows "Field Details (raw PDF properties)" in Signatures, and the "Raw PDF objects" panel in Versions — each marked with a "Raw" badge, and opened automatically.',
};
const TEMPLATES: SettingsToggle = {
  key: 'templatesEnabled',
  id: 'settingsTemplatesEnabled',
  label: 'Enable signature templates',
  hint: 'Shows the Signature Templates panel in the sidebar so you can save and reuse field layouts. Off by default.',
};
const REVISION_HISTORY: SettingsToggle = {
  key: 'includeRevisionHistoryByDefault',
  id: 'settingsIncludeRevisionHistory',
  label: 'Include versions when exporting / sharing document',
  hint: "Bundles your document's version history into exported and shared files. Takes a bit longer to prepare, since every past version is included.",
};
const CERTIFICATE_TOGGLES: SettingsToggle[] = [
  {
    key: 'certificateModifyEnabled',
    id: 'settingsCertModifyEnabled',
    label: 'Enable certificate modification tools',
    hint: 'Shows the "Modify" panel in Certificates, which lets you swap or corrupt the certificates behind a signature to see how a verifier reacts. For building test documents only — off by default.',
  },
  {
    key: 'certificateScratchpadEnabled',
    id: 'settingsCertScratchpadEnabled',
    label: 'Enable certificate scratchpad',
    hint: 'Shows the "Certificate scratchpad" panel in Certificates for pasting or dropping a certificate to inspect on its own, with no document required. Off by default.',
  },
  {
    key: 'trustSimulationEnabled',
    id: 'settingsTrustSimEnabled',
    label: 'Enable trust simulation',
    hint: "Shows the \"Trust simulation\" panel in Certificates: upload a root CA bundle and see whether the loaded document's chain would be trusted against it. Runs only for the current session, is clearly marked as simulated, and never changes the real report. Off by default.",
  },
];

/** The subtle toast shown for each setting that changed on Save. */
const CHANGE_MESSAGES: Record<keyof AppSettings, [on: string, off: string]> = {
  showRawPdfData: ['Raw PDF data panels enabled.', 'Raw PDF data panels disabled.'],
  includeRevisionHistoryByDefault: ['Version history will be included in exports.', 'Version history will be excluded from exports.'],
  templatesEnabled: ['Signature Templates panel enabled.', 'Signature Templates panel disabled.'],
  certificateModifyEnabled: ['Certificate modification tools enabled.', 'Certificate modification tools disabled.'],
  certificateScratchpadEnabled: ['Certificate scratchpad panel enabled.', 'Certificate scratchpad panel disabled.'],
  trustSimulationEnabled: ['Trust simulation panel enabled.', 'Trust simulation panel disabled.'],
};

@Component({
  selector: 'div[appSettingsModal]',
  templateUrl: './settings-modal.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    id: 'settingsModal',
    class: 'modal-backdrop',
    '[class.is-open]': 'ui.settingsModalOpen()',
    '[attr.aria-hidden]': '!ui.settingsModalOpen()',
    '(click)': 'onBackdrop($event)',
  },
})
export class SettingsModal {
  protected readonly ui = inject(UiService);
  protected readonly settings = inject(SettingsService);
  protected readonly templates = inject(TemplatesStore);
  private readonly notifications = inject(NotificationService);

  protected readonly tabs = TABS;
  protected readonly generalToggles = [RAW_DATA];
  protected readonly signatureToggles = [TEMPLATES];
  protected readonly revisionToggles = [REVISION_HISTORY];
  protected readonly certificateToggles = CERTIFICATE_TOGGLES;

  protected backupSummary(): string {
    const templateCount = this.templates.backupTemplateCount();
    const fieldCount = this.templates.backupFieldCount();
    return templateCount
      ? `${templateCount} template${plural(templateCount)} saved in this browser, ${fieldCount} field${plural(fieldCount)} in total.`
      : 'No templates saved in this browser yet — nothing to download.';
  }

  protected setDraft(key: keyof AppSettings, event: Event): void {
    this.settings.setDraft(key, (event.target as HTMLInputElement).checked);
  }

  protected close(): void {
    this.ui.settingsModalOpen.set(false);
  }

  protected onBackdrop(event: MouseEvent): void {
    if (isBackdropClick(event)) this.close();
  }

  protected onImportFile(input: HTMLInputElement): void {
    const file = input.files?.[0];
    // Reset so picking the same file again still fires change.
    input.value = '';
    void this.templates.importFile(file);
  }

  protected save(): void {
    const previous = this.settings.load();
    const next = { ...this.settings.draft() };
    this.settings.save(next);
    this.close();
    for (const key of Object.keys(CHANGE_MESSAGES) as (keyof AppSettings)[]) {
      if (next[key] === previous[key]) continue;
      const [on, off] = CHANGE_MESSAGES[key];
      this.notifications.show(next[key] ? on : off, 'info', 8000, true, { subtle: true });
    }
  }
}
