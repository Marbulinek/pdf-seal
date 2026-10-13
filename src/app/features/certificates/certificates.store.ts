import { DOCUMENT } from '@angular/common';
import { computed, inject } from '@angular/core';
import { patchState, signalStore, withComputed, withMethods, withProps, withState } from '@ngrx/signals';
import { ApiService } from '../../core/api.service';
import { errorMessage } from '../../core/document.service';
import { DocumentStore } from '../../core/document.store';
import type {
  CertificateChain,
  CertificateReport,
  ErrorPayload,
  ParsedCertificate,
  ScratchpadResult,
  TrustSimulationResult,
  ValidationStatus,
} from '../../core/models';
import { NotificationService } from '../../core/notification.service';
import { UiService } from '../../core/ui.service';
import { cssEscape, downloadBlob, flashElement } from '../../core/util/dom';
import { lazyInject } from '../../core/util/lazy';
import { DOCUMENTS, SIGNATURES } from '../../core/ports';
import { ViewerService } from '../../core/viewer.service';
import {
  ALL_STATUSES,
  CERT_OPERATIONS,
  buildSummaryMarkdown,
  certSafeFilename,
  checkMatchesFilterText,
  collectAllChecks,
  findCertIn,
  reportForDiff,
  type CertificateOperation,
} from './certificates-model';

export type CertificateTab = 'overview' | 'extensions' | 'validation' | 'raw';

export interface PendingModification {
  op: CertificateOperation;
  fieldName: string;
  targetFingerprint: string | null;
  file: File | null;
  parsed: ParsedCertificate[] | null;
  error: string | null;
}

interface CertificatesState {
  report: CertificateReport | null;
  /** The File this report describes (reference equality with activeFile). */
  loadedFor: File | null;
  loading: boolean;
  error: string | null;
  // Summary filter chips + free text over the check list.
  filterStatuses: ValidationStatus[];
  filterText: string;
  // Standalone scratchpad (no document needed).
  scratchpad: ScratchpadResult | null;
  scratchpadFile: File | null;
  scratchpadText: string;
  scratchpadLoading: boolean;
  scratchpadError: string | null;
  // Opt-in trust simulation, per session only.
  trustResults: Record<string, TrustSimulationResult> | null;
  trustLoading: boolean;
  trustError: string | null;
  trustFileName: string;
  // Sheets
  activeCertId: string | null;
  activeTab: CertificateTab;
  modify: PendingModification | null;
  modifyApplying: boolean;
  timelineField: string | null;
  /** Signature cards expanded (focusForField opens one). */
  openCards: string[];
}

const initialState: CertificatesState = {
  report: null,
  loadedFor: null,
  loading: false,
  error: null,
  filterStatuses: [...ALL_STATUSES],
  filterText: '',
  scratchpad: null,
  scratchpadFile: null,
  scratchpadText: '',
  scratchpadLoading: false,
  scratchpadError: null,
  trustResults: null,
  trustLoading: false,
  trustError: null,
  trustFileName: '',
  activeCertId: null,
  activeTab: 'overview',
  modify: null,
  modifyApplying: false,
  timelineField: null,
  openCards: [],
};

/**
 * The Certificates section: a pure renderer of the server's report
 * (lib/PdfCertificateReport.ts) plus the optional scratchpad, trust
 * simulation and modification tools.
 */
export const CertificatesStore = signalStore(
  { providedIn: 'root' },
  withState(initialState),
  withProps(() => ({
    _doc: inject(DocumentStore),
    _api: inject(ApiService),
    _ui: inject(UiService),
    _viewer: inject(ViewerService),
    _notifications: inject(NotificationService),
    _document: inject(DOCUMENT),
    _documents: lazyInject(DOCUMENTS),
    _signatures: lazyInject(SIGNATURES),
    _flags: { reloadPending: false },
  })),
  withComputed((store) => {
    const certById = (id: string | null | undefined) => (id ? findCertIn(store.report(), store.scratchpad(), id) : null);
    const allChecks = computed(() => {
      const report = store.report();
      return report ? collectAllChecks(report) : [];
    });
    const filterActive = computed(() => {
      const report = store.report();
      const counts = report?.summary.counts;
      const occurring = counts ? ALL_STATUSES.filter((s) => counts[s]) : [];
      return store.filterText().trim().length > 0 || occurring.some((s) => !store.filterStatuses().includes(s));
    });
    return {
      allChecks,
      filterActive,
      reportForActiveFile: computed(() => (store.loadedFor() === store._doc.activeFile() ? store.report() : null)),
      activeCert: computed(() => certById(store.activeCertId())),
      shownCheckCount: computed(
        () =>
          allChecks().filter((c) => store.filterStatuses().includes(c.status) && checkMatchesFilterText(c, store.filterText()))
            .length,
      ),
    };
  }),
  withMethods((store) => {
    const doc = store._doc;
    const ui = store._ui;
    const notify = store._notifications;

    const certById = (id: string | null | undefined): ParsedCertificate | null =>
      id ? findCertIn(store.report(), store.scratchpad(), id) : null;

    function chainContainingCert(certId: string): CertificateChain | null {
      const report = store.report();
      const fromReport = report?.chains.find((c) => c.certificateIds.includes(certId));
      if (fromReport) return fromReport;
      const scratch = store.scratchpad()?.chain;
      return scratch?.certificateIds.includes(certId) ? scratch : null;
    }

    function closeCertificateSheet(): void {
      ui.closeSheet('certificate');
      patchState(store, { activeCertId: null });
    }

    function closeModifySheet(): void {
      ui.closeSheet('certificateModify');
      patchState(store, { modify: null, modifyApplying: false });
    }

    function closeTimelineSheet(): void {
      ui.closeSheet('certificateTimeline');
      patchState(store, { timelineField: null });
    }

    function reset(): void {
      store._flags.reloadPending = false;
      patchState(store, {
        report: null,
        loadedFor: null,
        loading: false,
        error: null,
        activeCertId: null,
        filterStatuses: [...ALL_STATUSES],
        filterText: '',
        scratchpad: null,
        trustResults: null,
        openCards: [],
      });
      closeCertificateSheet();
      closeModifySheet();
      closeTimelineSheet();
    }

    async function loadIfNeeded(): Promise<void> {
      const file = doc.activeFile();
      if (!file) {
        patchState(store, { report: null, loadedFor: null, error: null });
        return;
      }
      // Reference equality with activeFile: every load/edit makes a new File.
      if (store.loadedFor() === file && store.report()) return;
      // Coalesce: a second request while one is in flight re-runs once.
      if (store.loading()) {
        store._flags.reloadPending = true;
        return;
      }
      patchState(store, { loading: true, error: null });
      try {
        const formData = new FormData();
        formData.append('pdfDocument', file);
        const response = await store._api.postForm('/api/certificates', formData);
        if (file !== doc.activeFile()) return;
        const payload = (await response.json().catch(() => ({}))) as { report?: CertificateReport } & ErrorPayload;
        if (file !== doc.activeFile()) return;
        if (!response.ok || !payload.report) throw new Error(payload?.error || 'The certificates could not be read.');
        patchState(store, { report: payload.report, loadedFor: file, trustResults: null });
      } catch (err) {
        if (file !== doc.activeFile()) return;
        patchState(store, { report: null, loadedFor: null, error: errorMessage(err) || 'The certificates could not be read.' });
      } finally {
        patchState(store, { loading: false });
        if (store._flags.reloadPending) {
          store._flags.reloadPending = false;
          loadIfNeeded();
        }
      }
    }

    async function copyText(text: string, label: string): Promise<void> {
      try {
        await navigator.clipboard.writeText(text);
        notify.show(`${label} copied`, 'success', 3000);
      } catch {
        notify.show('Could not copy to the clipboard.', 'error');
      }
    }

    function certDownload(blob: Blob, filename: string): void {
      downloadBlob(blob, filename);
      notify.show(`Downloaded ${filename}`, 'success');
    }

    function openCertificateSheet(certId: string, tab?: CertificateTab): void {
      if (!certById(certId)) return;
      // Only one sheet slides over the column at a time.
      store._signatures().deselect();
      ui.closeSheet('compare');
      closeTimelineSheet();
      patchState(store, { activeCertId: certId, activeTab: tab || 'overview' });
      ui.openSheet('certificate');
    }

    /** Certificates tree -> point at the field in the viewer, staying on Certificates. */
    function flashSignatureField(fieldName: string): void {
      const field = doc.fields().find((f) => f.name === fieldName);
      if (!field) {
        notify.show(`This signature's field (${fieldName}) is not on the document.`, 'info');
        return;
      }
      store._viewer.goToPageAndFlash(field.page, `.field-overlay[data-field-name="${cssEscape(fieldName)}"]`);
    }

    return {
      reset,
      loadIfNeeded,
      certById,
      chainContainingCert,
      copyText,
      openCertificateSheet,
      closeCertificateSheet,
      closeModifySheet,
      closeTimelineSheet,
      flashSignatureField,
      setActiveTab(tab: CertificateTab): void {
        patchState(store, { activeTab: tab });
      },
      // ---- Summary filters ----
      toggleFilterStatus(status: ValidationStatus): void {
        const set = new Set(store.filterStatuses());
        if (set.has(status)) set.delete(status);
        else set.add(status);
        patchState(store, { filterStatuses: [...set] });
      },
      setFilterText(text: string): void {
        patchState(store, { filterText: text });
      },
      clearFilter(): void {
        patchState(store, { filterStatuses: [...ALL_STATUSES], filterText: '' });
      },
      copySummary(): void {
        const report = store.report();
        if (report) copyText(buildSummaryMarkdown(report, certById), 'Summary');
      },
      copyJson(): void {
        const report = store.report();
        if (report) copyText(JSON.stringify(reportForDiff(report), null, 2), 'JSON');
      },
      setCardOpen(fieldName: string, open: boolean): void {
        const set = new Set(store.openCards());
        if (open) set.add(fieldName);
        else set.delete(fieldName);
        patchState(store, { openCards: [...set] });
      },
      /** Signatures/Overview -> Certificates: open the section and land on that signature. */
      async focusForField(fieldName: string): Promise<void> {
        await ui.goToSection('certificates');
        await loadIfNeeded();
        patchState(store, { openCards: [...new Set([...store.openCards(), fieldName])] });
        await store._viewer.afterRender();
        flashElement(store._document.querySelector(`[data-cert-signature-card="${cssEscape(fieldName)}"]`));
      },
      // ---- Export ----
      exportCertificate(format: 'pem' | 'der'): void {
        const cert = certById(store.activeCertId());
        if (!cert) return;
        if (format === 'pem') {
          certDownload(new Blob([cert.pem], { type: 'application/x-pem-file' }), `${certSafeFilename(cert)}.pem`);
          return;
        }
        const binary = atob(cert.derBase64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        certDownload(new Blob([bytes], { type: 'application/pkix-cert' }), `${certSafeFilename(cert)}.cer`);
      },
      exportChain(): void {
        const chain = chainContainingCert(store.activeCertId() ?? '');
        if (!chain) return;
        // Leaf first, then each issuer -- the order a verifier walks it.
        const pem = chain.certificateIds
          .map(certById)
          .filter((c): c is ParsedCertificate => !!c)
          .map((c) => c.pem)
          .join('');
        certDownload(new Blob([pem], { type: 'application/x-pem-file' }), 'chain.pem');
      },
      // ---- Scratchpad ----
      setScratchpadFile(file: File | null): void {
        patchState(store, { scratchpadFile: file, ...(file ? { scratchpadText: '' } : {}) });
      },
      setScratchpadText(text: string): void {
        patchState(store, { scratchpadText: text, ...(text.trim() ? { scratchpadFile: null } : {}) });
      },
      clearScratchpad(): void {
        patchState(store, { scratchpad: null, scratchpadFile: null, scratchpadText: '', scratchpadError: null });
      },
      async inspectScratchpad(): Promise<void> {
        const text = store.scratchpadText().trim();
        const file = store.scratchpadFile();
        patchState(store, { scratchpadError: null });
        if (!file && !text) {
          patchState(store, { scratchpadError: 'Paste a certificate or choose a file first.' });
          return;
        }
        patchState(store, { scratchpadLoading: true });
        try {
          const formData = new FormData();
          formData.append('certificateFile', file || new Blob([text], { type: 'application/x-pem-file' }), file?.name || 'pasted.pem');
          const response = await store._api.postForm('/api/certificates/inspect', formData);
          const payload = (await response.json().catch(() => ({}))) as ScratchpadResult & ErrorPayload;
          if (!response.ok) throw new Error(payload?.error || 'That could not be read as a certificate.');
          patchState(store, { scratchpad: payload });
        } catch (err) {
          patchState(store, { scratchpad: null, scratchpadError: errorMessage(err) || 'That could not be read as a certificate.' });
        } finally {
          patchState(store, { scratchpadLoading: false });
        }
      },
      // ---- Trust simulation ----
      async runTrustSimulation(bundleFile: File): Promise<void> {
        const report = store.report();
        patchState(store, { trustFileName: bundleFile.name });
        if (!report?.chains?.length) {
          patchState(store, { trustError: 'There is no chain in the current document to simulate against.' });
          return;
        }
        patchState(store, { trustError: null, trustLoading: true });
        const results: Record<string, TrustSimulationResult> = {};
        try {
          for (const chain of report.chains) {
            const chainCerts = chain.certificateIds.map(certById).filter((c): c is ParsedCertificate => !!c);
            if (!chainCerts.length) continue;
            const formData = new FormData();
            formData.append('rootBundle', bundleFile);
            formData.append('chainCertificates', JSON.stringify(chainCerts.map((c) => ({ derBase64: c.derBase64 }))));
            const response = await store._api.postForm('/api/certificates/simulate-trust', formData);
            const payload = (await response.json().catch(() => ({}))) as { simulated?: TrustSimulationResult } & ErrorPayload;
            if (!response.ok || !payload.simulated) throw new Error(payload?.error || 'That root bundle could not be read.');
            results[chain.id] = payload.simulated;
          }
          patchState(store, { trustResults: results });
        } catch (err) {
          patchState(store, { trustResults: null, trustError: errorMessage(err) || 'That root bundle could not be read.' });
        } finally {
          patchState(store, { trustLoading: false });
        }
      },
      // ---- Timeline sheet ----
      openTimelineSheet(fieldName: string): void {
        if (!store.report()?.signatures.some((s) => s.fieldName === fieldName)) return;
        closeCertificateSheet();
        closeModifySheet();
        patchState(store, { timelineField: fieldName });
        ui.openSheet('certificateTimeline');
      },
      // ---- Modify ----
      openModifySheet(op: CertificateOperation, fieldName: string): void {
        const sig = store.report()?.signatures.find((s) => s.fieldName === fieldName);
        if (!sig || !CERT_OPERATIONS[op]) return;
        closeCertificateSheet();
        closeTimelineSheet();
        store._signatures().deselect();
        patchState(store, {
          modify: { op, fieldName, targetFingerprint: null, file: null, parsed: null, error: null },
          modifyApplying: false,
        });
        ui.openSheet('certificateModify');
      },
      setModifyTarget(fingerprint: string): void {
        const modify = store.modify();
        if (modify) patchState(store, { modify: { ...modify, targetFingerprint: fingerprint } });
      },
      async pickModifyFile(file: File): Promise<void> {
        const modify = store.modify();
        if (!modify || !file) return;
        const pending: PendingModification = { ...modify, file, parsed: null, error: null };
        patchState(store, { modify: pending });
        try {
          const formData = new FormData();
          formData.append('certificateFile', file);
          const response = await store._api.postForm('/api/certificates/inspect', formData);
          const payload = (await response.json().catch(() => ({}))) as ScratchpadResult & ErrorPayload;
          if (store.modify()?.file !== file) return; // sheet moved on
          if (!response.ok) throw new Error(payload?.error || 'That file could not be read as a certificate.');
          patchState(store, { modify: { ...pending, parsed: payload.certificates } });
        } catch (err) {
          if (store.modify()?.file !== file) return;
          patchState(store, { modify: { ...pending, error: errorMessage(err) } });
        }
      },
      async confirmModification(): Promise<void> {
        const state = store.modify();
        // Blocked mid-load/mid-update, the same as undo/redo.
        if (!state || !doc.activeFile() || doc.isDocumentUpdating() || doc.documentLoadInFlight()) return;
        const documents = store._documents();
        await documents.ensureRevisionHydration();
        patchState(store, { modifyApplying: true });
        const toast = notify.show('Rewriting the signature…', 'loading', 0);
        // Committed to undo history only on success.
        const preModifySnapshot = documents.captureSnapshot();
        const activeFile = doc.activeFile() as File;
        try {
          const formData = new FormData();
          formData.append('pdfDocument', activeFile);
          formData.append('operation', state.op);
          formData.append('signatureField', state.fieldName);
          if (state.targetFingerprint) formData.append('targetFingerprint', state.targetFingerprint);
          if (state.file) formData.append('certificateFile', state.file);

          const response = await store._api.postForm('/api/certificates/modify', formData);
          if (!response.ok) {
            const payload = (await response.json().catch(() => ({}))) as ErrorPayload;
            throw new Error(payload?.error || 'The change could not be applied.');
          }
          let meta: { removedCertificates?: string[]; signatureNowInvalid?: boolean } | null = null;
          const header = response.headers.get('X-Certificate-Modification');
          if (header) {
            try {
              meta = JSON.parse(decodeURIComponent(header));
            } catch {
              /* informational only */
            }
          }
          const blob = await response.blob();
          const updated = new File([blob], activeFile.name, { type: 'application/pdf' });
          toast.dismiss();
          closeModifySheet();
          // One reload path for everything.
          await documents.processNewFile(updated, { preservePage: true, isEdit: true });
          store._signatures().commitSnapshot(preModifySnapshot);
          const removed = meta?.removedCertificates?.length ? ` Removed ${meta.removedCertificates.join(', ')}.` : '';
          notify.show(
            `Signature rewritten.${removed}${meta?.signatureNowInvalid ? ' The signature no longer verifies.' : ' The signature still verifies.'}`,
            meta?.signatureNowInvalid ? 'info' : 'success',
            8000,
          );
        } catch (err) {
          toast.dismiss();
          patchState(store, { modifyApplying: false });
          notify.show(errorMessage(err), 'error', 10000);
        }
      },
    };
  }),
);

export type CertificatesStore = InstanceType<typeof CertificatesStore>;
