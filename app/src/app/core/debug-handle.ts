import type { Injector } from '@angular/core';
import { CertificatesStore } from '../features/certificates/certificates.store';
import { OverviewStore } from '../features/overview/overview.store';
import { SignaturesStore } from '../features/signatures/signatures.store';
import { TemplatesStore } from '../features/signatures/templates.store';
import { VersionsStore } from '../features/versions/versions.store';
import { DocumentService } from './document.service';
import { DocumentStore } from './document.store';
import { ViewerService } from './viewer.service';

/**
 * Development builds only (`npm run dev`): the app's services and stores on
 * `window.pdfSeal`, so the measurement scenarios in docs/performance.md can be
 * driven from the devtools console (e.g. `await pdfSeal.signatures.applyPending()`).
 */
export interface PdfSealDebugHandle {
  document: DocumentStore;
  documents: DocumentService;
  viewer: ViewerService;
  signatures: SignaturesStore;
  templates: TemplatesStore;
  overview: OverviewStore;
  versions: VersionsStore;
  certificates: CertificatesStore;
}

declare global {
  interface Window {
    pdfSeal?: PdfSealDebugHandle;
  }
}

export function exposeDebugHandle(injector: Injector): void {
  window.pdfSeal = {
    document: injector.get(DocumentStore),
    documents: injector.get(DocumentService),
    viewer: injector.get(ViewerService),
    signatures: injector.get(SignaturesStore),
    templates: injector.get(TemplatesStore),
    overview: injector.get(OverviewStore),
    versions: injector.get(VersionsStore),
    certificates: injector.get(CertificatesStore),
  };
}
