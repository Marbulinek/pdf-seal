import { Injectable, inject, signal } from '@angular/core';
import { ApiService } from '../../core/api.service';
import { errorMessage } from '../../core/document.service';
import { DocumentStore } from '../../core/document.store';
import { NotificationService, type NotificationHandle } from '../../core/notification.service';
import { SettingsService } from '../../core/settings.service';
import { UiService } from '../../core/ui.service';
import { blobToBase64 } from '../../core/util/base64';
import { copyText, downloadBlob } from '../../core/util/dom';
import { stripPdfExt } from '../../core/util/format';
import { lazyInject } from '../../core/util/lazy';
import { DOCUMENTS, SIGNATURES, type ExportPort } from '../../core/ports';
import { VersionStoreService } from '../../core/version-store.service';

/**
 * Getting the document out: Save As (download), Copy as Base64, and
 * bundling the locally-stored version history into the exported file.
 */
@Injectable({ providedIn: 'root' })
export class ExportService implements ExportPort {
  private readonly store = inject(DocumentStore);
  private readonly api = inject(ApiService);
  private readonly db = inject(VersionStoreService);
  private readonly settings = inject(SettingsService);
  private readonly ui = inject(UiService);
  private readonly notifications = inject(NotificationService);
  private readonly documents = lazyInject(DOCUMENTS);
  private readonly signatures = lazyInject(SIGNATURES);

  // Save As modal
  readonly saveAsName = signal('');
  readonly saveAsStatus = signal<{ message: string; type: 'error' | 'success' } | null>(null);
  readonly saveAsBusy = signal(false);

  /**
   * Bundles every locally-stored prior version plus the current document into
   * one PDF via /api/revisions/bundle. XHR for upload progress.
   */
  async bundleRevisionHistoryPdf(onProgress?: (loaded: number, total: number) => void): Promise<Blob> {
    // Bundling mid-hydration would export whatever hadn't been stored yet.
    await this.documents().ensureRevisionHydration();
    const sessionId = this.store.documentSessionId();
    const count = this.store.documentRevisionCount();
    const priorMetas = (await this.db.listMeta(sessionId)).filter((meta) => meta.index < count);
    const priorBlobs = await Promise.all(priorMetas.map((meta) => this.db.getBlob(sessionId ?? '', meta.index)));

    const formData = new FormData();
    formData.append('pdfDocument', this.store.activeFile() as Blob);
    priorMetas.forEach((meta, i) => {
      const blob = priorBlobs[i];
      if (blob) formData.append('priorRevisions', blob, `revision-${meta.index}.pdf`);
    });

    return this.api.upload<Blob>('/api/revisions/bundle', formData, {
      responseType: 'blob',
      onProgress,
      errorMessage: (status) => `Bundling failed (status ${status}).`,
      networkError: 'Network error while bundling revision history.',
    }).promise;
  }

  /**
   * Bundling behind a persistent, non-closable notification. The percentage
   * only tracks the (fast) upload, so past 100% the copy drops the number.
   */
  async bundleWithNotification(): Promise<{ blob: Blob; toast: NotificationHandle }> {
    const label = 'Preparing export — bundling revisions';
    const toast = this.notifications.show(`${label}…`, 'loading', 0, false);
    try {
      const blob = await this.bundleRevisionHistoryPdf((loaded, total) => {
        const percent = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
        toast.setMessage(percent < 100 ? `${label}… ${percent}%` : `${label}…`);
      });
      return { blob, toast };
    } catch (err) {
      toast.dismiss();
      throw err;
    }
  }

  openSaveAs(): void {
    const file = this.store.activeFile();
    if (!file) return;
    this.saveAsStatus.set(null);
    this.saveAsName.set(stripPdfExt(`updated_${file.name}`));
    this.ui.saveAsModalOpen.set(true);
  }

  closeSaveAs(): void {
    this.ui.saveAsModalOpen.set(false);
  }

  async doSaveAs(): Promise<void> {
    let name = this.saveAsName().trim();
    if (!name) {
      this.saveAsStatus.set({ message: 'Please enter a file name.', type: 'error' });
      return;
    }
    // Strip characters unsafe in file names, and a trailing .pdf.
    name = stripPdfExt(name).replace(/[\\/:*?"<>|]/g, '').trim();
    if (!name) {
      this.saveAsStatus.set({ message: 'Please enter a valid file name.', type: 'error' });
      return;
    }

    // Staged edits live only in the working fields -- apply them first.
    if (this.signatures().pendingCount()) {
      this.saveAsBusy.set(true);
      const applied = await this.signatures().applyPending();
      this.saveAsBusy.set(false);
      if (!applied) return;
    }

    let fileToSave: Blob | null = this.store.activeFile();
    if (!fileToSave) return;
    let toast: NotificationHandle | null = null;
    if (this.settings.stored().includeRevisionHistoryByDefault) {
      this.saveAsStatus.set(null);
      this.saveAsBusy.set(true);
      try {
        ({ blob: fileToSave, toast } = await this.bundleWithNotification());
      } catch (err) {
        this.saveAsStatus.set({ message: `Could not include revision history: ${errorMessage(err)}`, type: 'error' });
        this.saveAsBusy.set(false);
        return;
      }
      this.saveAsBusy.set(false);
    }

    downloadBlob(fileToSave, `${name}.pdf`);
    toast?.dismiss();
    this.closeSaveAs();
    this.notifications.show('PDF downloaded!', 'success');
  }

  /** Copies the document as Base64 -- applying staged edits / bundling first if needed. */
  async copyBase64(): Promise<void> {
    if (!this.store.activeFile()) return;
    if (this.signatures().pendingCount() && !(await this.signatures().applyPending())) return;
    let fileToCopy: Blob | null = this.store.activeFile();
    if (!fileToCopy) return;
    let toast: NotificationHandle | null = null;
    try {
      if (this.settings.stored().includeRevisionHistoryByDefault) {
        ({ blob: fileToCopy, toast } = await this.bundleWithNotification());
      }
      const base64data = await blobToBase64(fileToCopy);
      await copyText(base64data);
      toast?.dismiss();
      this.notifications.show('Copied to clipboard!', 'success');
    } catch (err) {
      console.error(err);
      toast?.dismiss();
      this.notifications.show('Copy failed: ' + errorMessage(err), 'error');
    }
  }
}
