import { ChangeDetectionStrategy, Component } from '@angular/core';
import { Base64Modal } from './base64-modal';
import { CloseDocumentModal } from './close-document-modal';
import { DeleteTemplateModal } from './delete-template-modal';
import { DemoReplaceModal } from './demo-replace-modal';
import { DiagnosticsModal } from './diagnostics-modal';
import { ExtensionModal } from './extension-modal';
import { FieldInfoModal } from './field-info-modal';
import { HelpModal } from './help-modal';
import { PlaceTemplateCleanupModal } from './place-template-cleanup-modal';
import { RawObjectModal } from './raw-object-modal';
import { RemoveFieldModal } from './remove-field-modal';
import { RemoveTemplateItemModal } from './remove-template-item-modal';
import { SaveAsModal } from './save-as-modal';
import { SettingsModal } from './settings-modal';
import { ShareModal } from './share-modal';
import { TemplateImportModal } from './template-import-modal';
import { TemplateMoveItemModal } from './template-move-item-modal';
import { TemplateNameModal } from './template-name-modal';
import { XmpRawModal } from './xmp-raw-modal';

/**
 * Every modal backdrop, in the original DOM order (a later backdrop stacks
 * over an earlier one -- e.g. the template import over Settings).
 */
@Component({
  selector: 'app-modals',
  imports: [
    ExtensionModal,
    DiagnosticsModal,
    Base64Modal,
    SettingsModal,
    HelpModal,
    DemoReplaceModal,
    SaveAsModal,
    RemoveFieldModal,
    CloseDocumentModal,
    TemplateNameModal,
    TemplateMoveItemModal,
    DeleteTemplateModal,
    RemoveTemplateItemModal,
    PlaceTemplateCleanupModal,
    TemplateImportModal,
    XmpRawModal,
    FieldInfoModal,
    RawObjectModal,
    ShareModal,
  ],
  template: `
    <div appExtensionModal></div>
    <div appDiagnosticsModal></div>
    <div appBase64Modal></div>
    <div appSettingsModal></div>
    <div appHelpModal></div>
    <div appDemoReplaceModal></div>
    <div appSaveAsModal></div>
    <div appRemoveFieldModal></div>
    <div appCloseDocumentModal></div>
    <div appTemplateNameModal></div>
    <div appTemplateMoveItemModal></div>
    <div appDeleteTemplateModal></div>
    <div appRemoveTemplateItemModal></div>
    <div appPlaceTemplateCleanupModal></div>
    <div appTemplateImportModal></div>
    <div appXmpRawModal></div>
    <div appFieldInfoModal></div>
    <div appRawObjectModal></div>
    <div appShareModal></div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Modals {}
