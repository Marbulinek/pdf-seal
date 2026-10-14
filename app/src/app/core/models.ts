// Shapes of the data the server returns and the app keeps in memory. The
// server-side source of truth is server/lib/PdfSignatureTool.ts, server/lib/PdfRevisionTool.ts
// and server/lib/PdfCertificateReport.ts -- these interfaces describe exactly what the
// UI reads (the server modules can't be imported here: they depend on node:crypto).

export interface PdfRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ExtraWidget {
  page: number | null;
  rect: PdfRect | null;
}

/** Raw PDF dictionary entries as display strings, keyed by PDF key (no slash). */
export type RawEntries = Record<string, string>;

/** One form field on the open document (`/api/info` -> `fields`). */
export interface DocField {
  name: string;
  /** Stamped whenever the baseline is synced; stays fixed across a pre-Apply rename. */
  __baselineName?: string;
  type: string;
  required?: boolean;
  readOnly?: boolean;
  multiline?: boolean;
  tooltip?: string | null;
  page: number | null;
  signed?: boolean;
  raw?: RawEntries;
  extraWidgets?: ExtraWidget[];
  objectRefs?: string[];
  rect: PdfRect | null;
}

export type FieldOp =
  | {
      op: 'add';
      name: string;
      type: 'signature';
      page: number | null;
      x: number;
      y: number;
      width: number;
      height: number;
      required: boolean;
    }
  | {
      op: 'edit';
      originalName: string;
      name: string;
      x: number;
      y: number;
      width: number;
      height: number;
      required: boolean;
      _positionChanged: boolean;
      _sizeChanged: boolean;
      _requiredChanged: boolean;
    }
  | { op: 'remove'; name: string };

// ---------------------------------------------------------------------------
// /api/info
// ---------------------------------------------------------------------------

export interface DocStamp {
  id: string;
  ref: string | null;
  page: number | null;
  rect: PdfRect | null;
  kind: 'text' | 'image' | 'external';
  text?: string;
  color?: string;
  name?: string;
  note?: string;
  author?: string;
  opacity?: number;
  locked?: boolean;
  createdByPdfSeal?: boolean;
  objectRefs?: string[];
  raw?: RawEntries;
}

export interface DocAnnotation {
  ref: string | null;
  page: number | null;
  rect: PdfRect | null;
  subtype: string;
  kind: 'link' | 'comment' | 'markup' | 'other';
  contents?: string;
  author?: string;
  modified?: string;
  uri?: string;
  destPage?: number;
  raw?: RawEntries;
}

export interface DocMetadata {
  title: string | null;
  author: string | null;
  subject: string | null;
  keywords: string | string[] | null;
  creator: string | null;
  producer: string | null;
  creationDate: string | null;
  modificationDate: string | null;
  pageCount: number | null;
}

export interface OverviewPage {
  index: number;
  width: number;
  height: number;
  rotation: number;
  sizeName: string;
  orientation: string;
}

export interface OverviewAttachment {
  filename: string;
  mimeType: string | null;
  size: number | null;
}

export interface XmpMetadata {
  title: string | null;
  creator: string | null;
  creatorTool: string | null;
  createDate: string | null;
  modifyDate: string | null;
  documentId: string | null;
  instanceId: string | null;
  raw: string;
}

export interface OverviewFeatures {
  encrypted: boolean;
  pdfA: string;
  linearized: boolean;
  xfa: boolean;
  acroForm: boolean;
  signatureFieldCount: number;
  javascript: boolean;
  attachmentCount: number;
  xmpMetadata: boolean;
  incrementalUpdates: number | null;
  signatureCount: number;
  certification: number | null;
  stampCount: number;
  annotationCount: number;
}

export interface DocumentOverviewData {
  documentInfo: DocMetadata & { pdfVersion: string | null; fileSize: number | null; pageCount: number | null };
  features: OverviewFeatures;
  pages: OverviewPage[];
  attachments: OverviewAttachment[];
  xmp: XmpMetadata | null;
  documentIds: {
    permanent: string | null;
    changing: string | null;
    xmpDocumentId: string | null;
    xmpInstanceId: string | null;
  };
}

export interface InfoFieldsResponse {
  fields?: DocField[];
  stamps?: DocStamp[];
}

export interface InfoFullResponse extends InfoFieldsResponse {
  metadata?: DocMetadata;
  rawInfo?: Record<string, unknown>;
  annotations?: DocAnnotation[];
  overview?: DocumentOverviewData;
  error?: string;
}

// ---------------------------------------------------------------------------
// /api/revisions and /api/revisions/diff
// ---------------------------------------------------------------------------

export type RevisionSignatureInfo = {
  fieldName: string;
  name: string | null;
  reason: string | null;
  location: string | null;
  signingTime: string | null;
  subFilter: string | null;
  contactInfo: string | null;
  byteRange: number[] | null;
};

export interface RevisionFieldSummary {
  name: string;
  type: string;
  required: boolean;
  readOnly: boolean;
  page: number | null;
}

export interface RevisionChangeSummary {
  pageCount: number | null;
  textCount: number;
  imageCount: number;
  fieldCount: number;
  acroFormCount: number;
  metadataFieldCount: number;
  signatureCount: number;
  stampCount: number;
}

/** What /api/revisions returns per version (minus its batch index/isFinal). */
export interface RevisionSummary {
  byteLength?: number;
  xrefOffset?: number | null;
  parseError: string | null;
  pageCount: number | null;
  metadata: DocMetadata | null;
  fields: RevisionFieldSummary[] | null;
  signatures: RevisionSignatureInfo[];
  stamps: DocStamp[] | null;
  changeSummary?: RevisionChangeSummary;
}

export interface ValueChange {
  key: string;
  before: unknown;
  after: unknown;
}

export interface DiffFieldEntry {
  name: string;
  type?: string;
  required?: boolean;
  readOnly?: boolean;
  page: number | null;
  rect: PdfRect | null;
}

export type DiffSignatureEntry = RevisionSignatureInfo & {
  page: number | null;
  rect: PdfRect | null;
};

export interface DiffStampEntry {
  id: string;
  kind?: string;
  page: number | null;
  rect: PdfRect | null;
  text: string | null;
  name: string | null;
}

export interface DictionaryChangeEntry {
  key: string;
  before: string;
  after: string;
  status: 'added' | 'removed' | 'changed';
}

export interface StreamDiffResult {
  available: boolean;
  contentUnchanged: boolean;
  added: string[];
  removed: string[];
  truncated: boolean;
  rawByteLengthBefore: number | null;
  rawByteLengthAfter: number | null;
}

/** A plain-data dump of a PDF object, as produced by pdfValueToPlain(). */
export type PdfPlainValue = string | number | boolean | null | PdfPlainValue[] | { [key: string]: PdfPlainValue };

export interface RawObjectPreview {
  key: string;
  page: number | null;
  rects: PdfRect[];
  type: string | null;
  subtype: string | null;
  previewMode: 'rects' | 'visual-page' | 'none';
  hasVisualLocation: boolean;
  noPreviewReason: 'renders-identically' | 'document-level' | 'no-geometry' | 'page-unknown' | null;
  category: string | null;
  fieldName: string | null;
  changesText: string;
  humanName: string | null;
  label: string;
  dictionaryChanges: DictionaryChangeEntry[];
  streamDiff: StreamDiffResult | null;
  classifications: string[];
  sourceBefore: PdfPlainValue | null;
  sourceAfter: PdfPlainValue | null;
  sourceTruncated: boolean;
}

export interface RevisionChecklist {
  pagesUnchanged: boolean;
  pagesChangedCount: number;
  textUnchanged: boolean;
  textChangedCount: number;
  imagesUnchanged: boolean;
  imagesChangedCount: number;
  signatureFieldsUnchanged: boolean;
  signatureFieldsChangedCount: number;
  acroFormUnchanged: boolean;
  acroFormChangedCount: number;
  stampsUnchanged: boolean;
  stampsChangedCount: number;
  metadataUnchanged: boolean;
  metadataChangedCount: number;
  signatureUnchanged: boolean;
  signatureChangedCount: number;
}

export interface RevisionDiff {
  byteLengthDelta: number;
  pageCountDelta: number;
  metadataChanges: ValueChange[];
  fieldChanges: {
    added: DiffFieldEntry[];
    removed: DiffFieldEntry[];
    modified: { name: string; page: number | null; rect: PdfRect | null; changes: ValueChange[] }[];
  };
  signatureChanges: { added: DiffSignatureEntry[]; removed: DiffSignatureEntry[] };
  stampChanges?: {
    added: DiffStampEntry[];
    removed: DiffStampEntry[];
    modified: { id: string; label: string; page: number | null; rect: PdfRect | null; changes: ValueChange[] }[];
  };
  objectChanges: {
    added: string[];
    removed: string[];
    modified: string[];
    addedDetails?: RawObjectPreview[];
    removedDetails?: RawObjectPreview[];
    modifiedDetails?: RawObjectPreview[];
    truncated: boolean;
  };
  checklist?: RevisionChecklist;
  integrity?: { ok: boolean; issues: string[] };
}

// ---------------------------------------------------------------------------
// /api/certificates*
// ---------------------------------------------------------------------------

export type ValidationStatus = 'pass' | 'warn' | 'fail' | 'unknown';

export interface ValidationResult {
  id: string;
  label: string;
  status: ValidationStatus;
  detail: string;
  explanation: string;
}

export interface DistinguishedName {
  formatted: string;
  commonName: string | null;
  organization: string | null;
  organizationalUnit: string | null;
  country: string | null;
  email: string | null;
}

export interface CertificateExtensions {
  basicConstraints: { critical: boolean; isCa: boolean; pathLenConstraint: number | null } | null;
  keyUsage: { critical: boolean; usages: string[]; bits: number } | null;
  extendedKeyUsage: { critical: boolean; oids: string[]; names: string[] } | null;
  subjectKeyIdentifier: string | null;
  authorityKeyIdentifier: { keyIdentifier: string | null; issuerDn: string | null; serial: string | null } | null;
  subjectAltNames: { type: string; value: string }[];
  crlDistributionPoints: string[];
  authorityInfoAccess: { ocsp: string[]; caIssuers: string[] };
  certificatePolicies: { oid: string; name: string | null; cps: string | null }[];
  unrecognizedCritical: string[];
}

export type CertificateRole = 'signer' | 'intermediate' | 'root' | 'unknown';

export interface ParsedCertificate {
  id: string;
  parseError: string | null;
  version: number;
  serialNumber: string;
  subject: DistinguishedName;
  issuer: DistinguishedName;
  validFrom: string;
  validTo: string;
  isExpired: boolean;
  isNotYetValid: boolean;
  daysUntilExpiry: number | null;
  publicKey: { algorithm: string; keySize: number | null; namedCurve: string | null; exponent: string | null };
  signatureAlgorithm: { oid: string; name: string; hash: string | null };
  fingerprints: { sha256: string };
  extensions: CertificateExtensions;
  selfIssued: boolean;
  selfSigned: boolean;
  role: CertificateRole;
  sources: { kind: string; signatureFieldName: string | null; objectRef: string | null }[];
  pem: string;
  derBase64: string;
  derLength: number;
  checks: ValidationResult[];
}

export interface CertificateChain {
  id: string;
  signatureFieldName: string | null;
  certificateIds: string[];
  links: { subjectId: string; issuerId: string; checks: ValidationResult[] }[];
  complete: boolean;
  brokenAtIndex: number | null;
  missingIssuerDn: string | null;
  checks: ValidationResult[];
}

export interface CmsSlot {
  byteRange: [number, number, number, number];
  capacityBytes: number;
  derLength: number;
  headroomBytes: number;
  coversWholeFile: boolean;
  trailingBytes: number;
}

export interface ReportSignature {
  fieldName: string;
  page: number | null;
  name: string | null;
  reason: string | null;
  location: string | null;
  signingTimeClaimed: string | null;
  cmsSlot: CmsSlot | null;
  cmsError: string | null;
  signedAttributes: { signingTime: string | null } | null;
  hasTimestampToken: boolean;
  timestampTime: string | null;
  certificateIds: string[];
  signerCertificateId: string | null;
  chainId: string | null;
  revisionCoverage: { coveredRevision: number | null; revisionCount: number } | null;
  checks: ValidationResult[];
  status: ValidationStatus;
}

export interface StatusCounts {
  pass: number;
  warn: number;
  fail: number;
  unknown: number;
}

export interface CertificateReport {
  generatedAt: string;
  documentHasSignatures: boolean;
  signatureFieldCount: number;
  unsignedSignatureFieldNames: string[];
  signatures: ReportSignature[];
  certificates: ParsedCertificate[];
  chains: CertificateChain[];
  unchainedCertificateIds: string[];
  trust: { hasTrustStore: false; note: string };
  summary: { status: ValidationStatus; headline: string; counts: StatusCounts };
  warnings: string[];
  truncated: boolean;
}

export interface ScratchpadResult {
  certificates: ParsedCertificate[];
  chain: CertificateChain | null;
  links: { subjectIndex: number; issuerIndex: number; checks: ValidationResult[] }[] | null;
}

export interface TrustSimulationResult {
  status: 'pass' | 'fail';
  detail: string;
  matchedRootSubject: string | null;
  extendedWithIssuer: boolean;
}

export interface ErrorPayload {
  error?: string;
}
