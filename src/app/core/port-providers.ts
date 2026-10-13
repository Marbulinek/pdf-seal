import type { Provider } from '@angular/core';
import { CertificatesStore } from '../features/certificates/certificates.store';
import { ExportService } from '../features/export/export.service';
import { OverviewStore } from '../features/overview/overview.store';
import { ShareService } from '../features/share/share.service';
import { SignaturesStore } from '../features/signatures/signatures.store';
import { VersionsStore } from '../features/versions/versions.store';
import { DocumentService } from './document.service';
import {
  CERTIFICATES,
  DOCUMENTS,
  EXPORT,
  OVERVIEW,
  SHARE,
  SIGNATURES,
  VERSIONS,
  type CertificatesPort,
  type OverviewPort,
  type SignaturesPort,
  type VersionsPort,
} from './ports';

/** Binds each port to the root service/store that implements it. */
export const PORT_PROVIDERS: Provider[] = [
  { provide: DOCUMENTS, useExisting: DocumentService },
  { provide: SIGNATURES, useExisting: SignaturesStore },
  { provide: OVERVIEW, useExisting: OverviewStore },
  { provide: VERSIONS, useExisting: VersionsStore },
  { provide: CERTIFICATES, useExisting: CertificatesStore },
  { provide: SHARE, useExisting: ShareService },
  { provide: EXPORT, useExisting: ExportService },
];

// Compile-time proof that each store satisfies its port (useExisting itself
// isn't type-checked).
export type PortConformance = [
  SignaturesStore extends SignaturesPort ? true : never,
  OverviewStore extends OverviewPort ? true : never,
  VersionsStore extends VersionsPort ? true : never,
  CertificatesStore extends CertificatesPort ? true : never,
];
export const PORTS_CONFORM: PortConformance = [true, true, true, true];
