// Pure view-model logic behind the Certificates section. Every verdict
// printed comes from the report the server built (server/lib/PdfCertificateReport.ts);
// nothing about certificates is decided in the browser.

import type {
  CertificateChain,
  CertificateReport,
  CertificateRole,
  ParsedCertificate,
  ReportSignature,
  ScratchpadResult,
  TrustSimulationResult,
  ValidationResult,
  ValidationStatus,
} from '../../core/models';
import { certFormatDate } from '../../core/util/format';

export const CERT_STATUS_GLYPH: Record<ValidationStatus, string> = { pass: '✓', warn: '!', fail: '✕', unknown: '?' };
export const CERT_STATUS_WORD: Record<ValidationStatus, string> = {
  pass: 'Pass',
  warn: 'Warning',
  fail: 'Failed',
  unknown: 'Not checked',
};
export const CERT_ROLE_LABEL: Record<CertificateRole, string> = {
  signer: 'Signing certificate',
  intermediate: 'Intermediate CA',
  root: 'Root CA',
  unknown: 'Certificate',
};
export const ALL_STATUSES: ValidationStatus[] = ['fail', 'warn', 'pass', 'unknown'];
export const SOURCE_KIND_LABEL: Record<string, string> = {
  cms: 'Signature content',
  'dss-certs': 'Document security store',
  'sig-cert': 'Signature /Cert entry',
  vri: 'Validation info (VRI)',
};

export function roleLabel(role: CertificateRole | string | undefined): string {
  return CERT_ROLE_LABEL[(role as CertificateRole) ?? 'unknown'] ?? CERT_ROLE_LABEL.unknown;
}

export function certDisplayName(cert: ParsedCertificate): string {
  return cert.subject.commonName || cert.subject.organization || cert.subject.formatted || 'Unnamed certificate';
}

export function certWorstStatus(statuses: ValidationStatus[]): ValidationStatus {
  if (statuses.includes('fail')) return 'fail';
  if (statuses.includes('warn')) return 'warn';
  if (statuses.includes('unknown')) return 'unknown';
  return statuses.length ? 'pass' : 'unknown';
}

export function certStatusOf(cert: ParsedCertificate): ValidationStatus {
  return certWorstStatus((cert.checks || []).map((c) => c.status));
}

export interface CheckSource {
  kind: 'signature' | 'chain' | 'link' | 'certificate';
  label: string;
  signatureFieldName?: string | null;
  certificateId?: string;
}

export type SourcedCheck = ValidationResult & { source: CheckSource };

/**
 * Mirrors `collectAllChecks` in server/lib/PdfCertificateReport.ts. Traversal order
 * (signatures -> chains -> links -> certificates) must match: it's what
 * `report.summary.counts` was computed over.
 */
export function collectAllChecks(report: CertificateReport): SourcedCheck[] {
  const byId = new Map((report.certificates || []).map((c) => [c.id, c]));
  const withSource = (checks: ValidationResult[] | undefined, source: CheckSource) => (checks || []).map((c) => ({ ...c, source }));
  const all: SourcedCheck[] = [];
  for (const signature of report.signatures || []) {
    all.push(
      ...withSource(signature.checks, {
        kind: 'signature',
        label: `Signature: ${signature.fieldName}`,
        signatureFieldName: signature.fieldName,
      }),
    );
  }
  for (const chain of report.chains || []) {
    const leaf = chain.certificateIds[0] ? byId.get(chain.certificateIds[0]) : undefined;
    const chainLabel = leaf ? certDisplayName(leaf) : (chain.signatureFieldName ?? chain.id);
    all.push(...withSource(chain.checks, { kind: 'chain', label: `Chain: ${chainLabel}`, signatureFieldName: chain.signatureFieldName }));
    for (const link of chain.links) {
      const subject = byId.get(link.subjectId);
      all.push(
        ...withSource(link.checks, {
          kind: 'link',
          label: subject ? certDisplayName(subject) : link.subjectId,
          certificateId: link.subjectId,
          signatureFieldName: chain.signatureFieldName,
        }),
      );
    }
  }
  for (const cert of report.certificates || []) {
    all.push(...withSource(cert.checks, { kind: 'certificate', label: certDisplayName(cert), certificateId: cert.id }));
  }
  return all;
}

export function checkMatchesFilterText(check: SourcedCheck, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return (
    (check.id || '').toLowerCase().includes(q) ||
    (check.label || '').toLowerCase().includes(q) ||
    (check.detail || '').toLowerCase().includes(q) ||
    (check.source?.label || '').toLowerCase().includes(q)
  );
}

/** Paste-ready Markdown for a bug ticket: every failing and warning check. */
export function buildSummaryMarkdown(report: CertificateReport, certById: (id: string) => ParsedCertificate | null): string {
  const notable = collectAllChecks(report).filter((c) => c.status === 'fail' || c.status === 'warn');
  const lines = [`# Certificate report — ${report.summary.headline}`, ''];
  const nCert = report.certificates.length;
  const nSig = report.signatures.length;
  lines.push(`${nCert} certificate${nCert === 1 ? '' : 's'}, ${nSig} signature${nSig === 1 ? '' : 's'}.`);
  lines.push('');
  if (!notable.length) {
    lines.push('No failing or warning checks.');
  } else {
    for (const check of notable) {
      const cert = check.source?.certificateId ? certById(check.source.certificateId) : null;
      lines.push(`- **${check.status === 'fail' ? 'FAIL' : 'WARN'}** ${check.label} — ${check.source?.label ?? 'Document'}`);
      lines.push(`  - ${check.detail}`);
      if (check.source?.signatureFieldName) lines.push(`  - Signature field: ${check.source.signatureFieldName}`);
      if (cert) lines.push(`  - Certificate: ${certDisplayName(cert)} (SHA-256 ${cert.fingerprints.sha256})`);
    }
  }
  for (const warning of report.warnings || []) lines.push(`- **READ** ${warning}`);
  return lines.join('\n');
}

/** The raw report minus fields that differ between two runs on the same file. */
export function reportForDiff(report: CertificateReport): Omit<CertificateReport, 'generatedAt'> {
  const { generatedAt: _generatedAt, ...stable } = report;
  return stable;
}

export function statusCounts(checks: ValidationResult[]): { status: ValidationStatus; count: number }[] {
  const counts: Record<ValidationStatus, number> = { fail: 0, warn: 0, unknown: 0, pass: 0 };
  for (const check of checks) counts[check.status] = (counts[check.status] ?? 0) + 1;
  return (['fail', 'warn', 'unknown', 'pass'] as ValidationStatus[])
    .filter((status) => counts[status])
    .map((status) => ({ status, count: counts[status] }));
}

// ---------------------------------------------------------------------------
// Chain tree
// ---------------------------------------------------------------------------

export interface ChainNode {
  status: ValidationStatus;
  depth: number;
  index: number;
  name: string;
  role: string;
  detail: string;
  certId: string | null;
  signatureField: string | null;
  missing: boolean;
  isRoot: boolean;
}

/** Root at the top, signer just above the signature; a missing issuer heads the tree. */
export function chainNodes(
  chain: CertificateChain | null | undefined,
  signature: ReportSignature | null,
  certById: (id: string) => ParsedCertificate | null,
): ChainNode[] {
  const nodes: ChainNode[] = [];
  let depth = 0;
  let index = 0;
  const push = (node: Omit<ChainNode, 'depth' | 'index' | 'isRoot'>) => {
    const d = depth++;
    nodes.push({ ...node, depth: d, index: index++, isRoot: d === 0 });
  };

  if (chain?.missingIssuerDn) {
    // Lead with the common name; keep the precise DN as the detail.
    const cn = /CN=([^,]+)/.exec(chain.missingIssuerDn);
    // 'unknown', not a warning: usually this is the root, which belongs in the
    // verifier's trust store rather than in the document.
    push({
      status: 'unknown',
      name: cn ? cn[1].trim() : chain.missingIssuerDn,
      role: 'Issuer not present in this file',
      detail: chain.missingIssuerDn,
      certId: null,
      signatureField: null,
      missing: true,
    });
  }
  // certificateIds is leaf-first; reverse so the root renders on top.
  for (const certId of [...(chain?.certificateIds || [])].reverse()) {
    const cert = certById(certId);
    if (!cert) continue;
    push({
      status: certStatusOf(cert),
      name: certDisplayName(cert),
      role: roleLabel(cert.role),
      detail: cert.isExpired ? 'Expired' : cert.isNotYetValid ? 'Not yet valid' : 'Within validity period',
      certId: cert.id,
      signatureField: null,
      missing: false,
    });
  }
  if (signature) {
    push({
      status: signature.status,
      name: signature.name || signature.fieldName,
      role: `Signature — field ${signature.fieldName}`,
      detail: signature.page !== null && signature.page !== undefined ? `Page ${signature.page + 1}` : '',
      certId: null,
      signatureField: signature.fieldName,
      missing: false,
    });
  }
  return nodes;
}

/** A flat (non-nested) list of certificates, e.g. "Other certificates" or the scratchpad. */
export function flatCertNodes(certs: ParsedCertificate[], detailOf: (cert: ParsedCertificate) => string): ChainNode[] {
  return certs.map((cert, i) => ({
    status: certStatusOf(cert),
    depth: 0,
    index: i,
    name: certDisplayName(cert),
    role: roleLabel(cert.role),
    detail: detailOf(cert),
    certId: cert.id,
    signatureField: null,
    missing: false,
    isRoot: false,
  }));
}

// ---------------------------------------------------------------------------
// Byte map
// ---------------------------------------------------------------------------

export interface ByteMap {
  segments: { cls: string; width: number; label: string }[];
  trailingNote: string | null;
  occupiedPct: number;
  headroomPct: number;
  occupiedLabel: string;
  headroomLabel: string;
}

/** What the signature covers vs. the unsigned /Contents gap, and slot occupancy. */
export function byteMapOf(sig: ReportSignature): ByteMap | null {
  const slot = sig.cmsSlot;
  if (!slot) return null;
  const [a, b, c, d] = slot.byteRange;
  const signed1End = a + b;
  const gapLength = Math.max(0, c - signed1End);
  const signed2End = c + d;
  const totalLength = signed2End + slot.trailingBytes;
  if (!totalLength) return null;
  const pct = (n: number) => Math.max(0, (n / totalLength) * 100);
  const fmt = (n: number) => n.toLocaleString();
  const segments = [
    { cls: 'is-signed', width: pct(signed1End), label: `Signed: bytes 0–${fmt(signed1End)}` },
    { cls: 'is-gap', width: pct(gapLength), label: `/Contents gap (unsigned): bytes ${fmt(signed1End)}–${fmt(c)}` },
    { cls: 'is-signed', width: pct(d), label: `Signed: bytes ${fmt(c)}–${fmt(signed2End)}` },
  ];
  if (slot.trailingBytes) {
    segments.push({
      cls: 'is-trailing',
      width: pct(slot.trailingBytes),
      label: `Not covered: bytes ${fmt(signed2End)}–${fmt(totalLength)} (${fmt(slot.trailingBytes)} bytes)`,
    });
  }
  const occupiedPct = slot.capacityBytes ? Math.min(100, (slot.derLength / slot.capacityBytes) * 100) : 0;
  return {
    segments,
    trailingNote: slot.trailingBytes
      ? `This signature does not cover the last ${fmt(slot.trailingBytes)} byte${slot.trailingBytes === 1 ? '' : 's'} of the file.`
      : null,
    occupiedPct,
    headroomPct: Math.max(0, 100 - occupiedPct),
    occupiedLabel: `CMS: ${fmt(slot.derLength)} of ${fmt(slot.capacityBytes)} bytes`,
    headroomLabel: `Headroom: ${fmt(slot.headroomBytes)} bytes`,
  };
}

// ---------------------------------------------------------------------------
// Validity timeline
// ---------------------------------------------------------------------------

export interface ValidityTimeline {
  rows: { name: string; status: ValidationStatus; left: number; width: number; title: string }[];
  markers: { cls: string; label: string; left: number; note: string }[];
  nowLeft: string;
  nowTitle: string;
  ticks: { align: 'start' | 'center' | 'end'; left: string; label: string }[];
  hasClaimed: boolean;
  hasTimestamp: boolean;
}

/**
 * Each chain certificate's validity window as a bar, the claimed signing time
 * and timestamp-token time as markers, and "now". Every bar's colour is the
 * server's own `cert.validity.window` verdict.
 */
export function validityTimeline(
  chain: CertificateChain | null | undefined,
  signature: ReportSignature,
  certById: (id: string) => ParsedCertificate | null,
  now = new Date(),
): ValidityTimeline | null {
  const certs = (chain?.certificateIds || []).map(certById).filter((c): c is ParsedCertificate => !!c);
  if (!certs.length) return null;
  const claimedTime = signature.signedAttributes?.signingTime || signature.signingTimeClaimed || null;
  const timestampTime = signature.timestampTime || null;

  const instants = [now];
  for (const cert of certs) instants.push(new Date(cert.validFrom), new Date(cert.validTo));
  if (claimedTime) instants.push(new Date(claimedTime));
  if (timestampTime) instants.push(new Date(timestampTime));
  const valid = instants.filter((d) => !Number.isNaN(d.getTime()));
  if (!valid.length) return null;

  // Breathing room either side so an edge bar isn't flush with the border.
  const minMs = Math.min(...valid.map((d) => d.getTime()));
  const maxMs = Math.max(...valid.map((d) => d.getTime()));
  const padMs = Math.max((maxMs - minMs) * 0.04, 1000 * 60 * 60 * 24);
  const domainStart = minMs - padMs;
  const domainEnd = maxMs + padMs;
  const domainSpan = Math.max(domainEnd - domainStart, 1);
  const pct = (ms: number) => Math.min(100, Math.max(0, ((ms - domainStart) / domainSpan) * 100));

  const rows = certs.flatMap((cert) => {
    const from = new Date(cert.validFrom).getTime();
    const to = new Date(cert.validTo).getTime();
    if (Number.isNaN(from) || Number.isNaN(to)) return [];
    const status = cert.checks?.find((c) => c.id === 'cert.validity.window')?.status ?? 'unknown';
    const left = pct(from);
    return [
      {
        name: certDisplayName(cert),
        status,
        left,
        width: Math.max(pct(to) - left, 0.5),
        title: `${certDisplayName(cert)}: ${certFormatDate(cert.validFrom) ?? '?'} – ${certFormatDate(cert.validTo) ?? '?'}`,
      },
    ];
  });

  const markers: ValidityTimeline['markers'] = [];
  if (claimedTime) {
    const ms = new Date(claimedTime).getTime();
    if (!Number.isNaN(ms)) {
      markers.push({
        cls: 'is-claimed',
        label: 'Signed (claimed)',
        left: pct(ms),
        note: `${certFormatDate(claimedTime)} — claimed by the signer, not proven`,
      });
    }
  }
  if (timestampTime) {
    const ms = new Date(timestampTime).getTime();
    if (!Number.isNaN(ms)) {
      markers.push({
        cls: 'is-timestamp',
        label: 'Timestamped',
        left: pct(ms),
        note:
          `${certFormatDate(timestampTime)} — ` +
          (signature.isDocumentTimestamp
            ? 'this document timestamp’s own time; the authority that issued it is not evaluated'
            : signature.timestampVerified === true
              ? 'from a timestamp token that verified; the authority that issued it is not evaluated'
              : signature.timestampVerified === false
                ? 'from a timestamp token that does not verify, so it proves nothing'
                : "from the timestamp token itself; not verified, but independent of the signer's own claim"),
      });
    }
  }

  const ticks = [domainStart, domainStart + domainSpan / 2, domainEnd].map((ms, i) => ({
    align: (i === 0 ? 'start' : i === 2 ? 'end' : 'center') as 'start' | 'center' | 'end',
    left: pct(ms).toFixed(2),
    label: certFormatDate(new Date(ms).toISOString()) ?? '',
  }));

  return {
    rows,
    markers,
    nowLeft: pct(now.getTime()).toFixed(2),
    nowTitle: `Now: ${certFormatDate(now.toISOString())}`,
    ticks,
    hasClaimed: !!claimedTime,
    hasTimestamp: !!timestampTime,
  };
}

// ---------------------------------------------------------------------------
// Signature evidence (shared with the Overview sheet)
// ---------------------------------------------------------------------------

export interface EvidenceRow {
  label: string;
  text: string;
  status?: ValidationStatus;
  /** "Show changes after signing" target, offered only for a native chain. */
  slot?: { from: number; to: number } | null;
}

/** The Trust row's wording for one chain: the simulation's answer, or none. */
function trustRow(trust: TrustSimulationResult | null): EvidenceRow {
  if (!trust) return { label: 'Trust', text: 'Not evaluated — no trust store', status: 'unknown' };
  return trust.status === 'pass'
    ? { label: 'Trust', text: 'Trusted by your bundle (simulated)', status: 'pass' }
    : { label: 'Trust', text: 'Not trusted by your bundle (simulated)', status: 'fail' };
}

/**
 * One fact per row; never a verdict -- "unknown" and "not checked" print
 * literally. Trust, timestamp and revocation are separate rows because they
 * are separate questions from whether the signature holds; `trust` is this
 * signature's chain's trust-simulation result, when one was run.
 */
export function signatureEvidenceRows(sig: ReportSignature, trust: TrustSimulationResult | null = null): EvidenceRow[] {
  const cov = sig.revisionCoverage;
  const check = (id: string) => sig.checks.find((c) => c.id === id);
  const rows: EvidenceRow[] = [];
  if (cov) {
    rows.push({
      label: 'Signed bytes',
      text:
        cov.coveredRevision !== null
          ? `End at revision ${cov.coveredRevision} of ${cov.revisionCount} in this file`
          : 'Do not end at a revision boundary',
    });
  }
  const digest = check('sig.messageDigest');
  if (digest) rows.push({ label: 'Digest', text: digest.detail, status: digest.status });
  const cms = check('sig.cryptographic');
  if (cms) rows.push({ label: 'CMS signature', text: cms.detail, status: cms.status });
  if (cov && cov.coveredRevision !== null) {
    const later = cov.revisionCount - cov.coveredRevision;
    const laterCheck = check('sig.laterChanges');
    rows.push({
      label: 'Later revisions',
      text: laterCheck?.detail ?? (later > 0 ? `${later} later revision${later === 1 ? '' : 's'}` : 'None'),
      status: laterCheck?.status,
      slot: later > 0 ? { from: cov.coveredRevision, to: cov.revisionCount } : null,
    });
  }
  const mdp = check('sig.docMdp');
  if (mdp) rows.push({ label: 'Certification (DocMDP)', text: mdp.detail, status: mdp.status });
  rows.push(trustRow(trust));
  const timestamp = check('sig.timestamp');
  if (timestamp) rows.push({ label: 'Timestamp', text: timestamp.detail, status: timestamp.status });
  rows.push({ label: 'Revocation', text: 'Not checked', status: 'unknown' });
  return rows;
}

const TIMESTAMP_FACT: Record<string, string> = {
  none: 'None',
  verified: 'Verified',
  invalid: 'Invalid',
  'not verified': 'Present, not verified',
};

/**
 * The document-level answers kept beside the verdict: trust (from the trust
 * simulation, when one was run), timestamps and revocation. None of them
 * changes the badge.
 */
export function trustFacts(
  report: CertificateReport,
  trustResults: Record<string, TrustSimulationResult> | null,
): { label: string; value: string }[] {
  const simulated = report.chains.map((c) => trustResults?.[c.id]).filter((r): r is TrustSimulationResult => !!r);
  const trust = !simulated.length
    ? 'Not evaluated'
    : simulated.every((r) => r.status === 'pass')
      ? 'Trusted (simulated)'
      : 'Not trusted (simulated)';

  // A document timestamp is its own time evidence; count the signatures' tokens.
  const signatures = report.signatures.filter((s) => !s.isDocumentTimestamp);
  const kinds = signatures.map((s) =>
    !s.hasTimestampToken ? 'none' : s.timestampVerified === true ? 'verified' : s.timestampVerified === false ? 'invalid' : 'not verified',
  );
  const distinct = [...new Set(kinds)];
  const documentTimestamps = report.signatures.length - signatures.length;
  const timestamp =
    (distinct.length === 1
      ? TIMESTAMP_FACT[distinct[0]]
      : distinct.map((k) => `${kinds.filter((x) => x === k).length} ${k}`).join(', ')) +
    (documentTimestamps ? ` · ${documentTimestamps} document timestamp${documentTimestamps === 1 ? '' : 's'}` : '');

  return [
    { label: 'Trust', value: trust },
    { label: 'Timestamp', value: timestamp },
    { label: 'Revocation', value: 'Not checked' },
  ];
}

// ---------------------------------------------------------------------------
// Modify
// ---------------------------------------------------------------------------

export type CertificateOperation = 'remove-certificate' | 'remove-intermediates' | 'replace-signer' | 'replace-chain';

export const CERT_OPERATIONS: Record<
  CertificateOperation,
  { label: string; blurb: string; needsTarget?: boolean; needsFile?: boolean; multiFile?: boolean }
> = {
  'remove-certificate': { label: 'Remove certificate', blurb: 'Drop one certificate from inside this signature.', needsTarget: true },
  'remove-intermediates': {
    label: 'Remove intermediate',
    blurb: 'Drop the CA certificates between the signer and the root, leaving an incomplete chain.',
  },
  'replace-signer': { label: 'Replace certificate', blurb: 'Swap the signer certificate for one from a file.', needsFile: true },
  'replace-chain': {
    label: 'Replace chain',
    blurb: 'Swap the CA certificates above the signer, keeping the signer itself.',
    needsFile: true,
    multiFile: true,
  },
};

export function intermediatesOf(sig: ReportSignature, own: ParsedCertificate[]): ParsedCertificate[] {
  return own.filter((c) => c.id !== sig.signerCertificateId && !c.selfIssued && c.extensions.basicConstraints?.isCa === true);
}

/**
 * Which operations a signature supports, and why not. Mirrors
 * describeAvailableOperations() in server/lib/PdfCertificateModifier.ts.
 */
export function availableOperations(
  sig: ReportSignature,
  certById: (id: string) => ParsedCertificate | null,
): { op: CertificateOperation; available: boolean; reason: string }[] {
  const own = (sig.certificateIds || []).map(certById).filter((c): c is ParsedCertificate => !!c);
  const intermediates = intermediatesOf(sig, own);
  const aboveSigner = own.filter((c) => c.id !== sig.signerCertificateId);
  const hasSigner = !!sig.signerCertificateId;
  return [
    { op: 'remove-certificate', available: own.length > 1, reason: 'This signature carries only one certificate.' },
    { op: 'remove-intermediates', available: intermediates.length > 0, reason: 'This signature carries no intermediate CA certificates.' },
    { op: 'replace-signer', available: hasSigner, reason: 'The signer certificate is not embedded in this document.' },
    {
      op: 'replace-chain',
      available: hasSigner && aboveSigner.length > 0,
      reason: hasSigner ? 'There are no CA certificates above the signer to replace.' : 'The signer certificate is not embedded in this document.',
    },
  ];
}

export function certSafeFilename(cert: ParsedCertificate): string {
  return (certDisplayName(cert).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'certificate').slice(0, 60);
}

export function findCertIn(
  report: CertificateReport | null,
  scratchpad: ScratchpadResult | null,
  id: string,
): ParsedCertificate | null {
  return report?.certificates.find((c) => c.id === id) ?? scratchpad?.certificates.find((c) => c.id === id) ?? null;
}

// ---------------------------------------------------------------------------
// Certificate sheet view model
// ---------------------------------------------------------------------------

export interface CertRow {
  label: string;
  /** null/'' render as "Not present" -- never a plausible default. */
  value: string | null;
  mono?: boolean;
  copy?: boolean;
}

export interface CertRowSection {
  title: string;
  rows: CertRow[];
}

export interface CertValidityBar {
  percent: number;
  tone: '' | 'is-warn' | 'is-fail';
  from: string;
  to: string;
}

/** The share of the certificate's life used up -- reads faster than two dates. */
export function certValidityBar(cert: ParsedCertificate, now = Date.now()): CertValidityBar | null {
  const start = new Date(cert.validFrom).getTime();
  const end = new Date(cert.validTo).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const percent = Math.max(0, Math.min(100, ((now - start) / (end - start)) * 100));
  const tone =
    cert.isExpired || cert.isNotYetValid ? 'is-fail' : cert.daysUntilExpiry !== null && cert.daysUntilExpiry <= 30 ? 'is-warn' : '';
  return { percent: Number(percent.toFixed(1)), tone, from: certFormatDate(cert.validFrom) || '—', to: certFormatDate(cert.validTo) || '—' };
}

export function certValidityState(cert: ParsedCertificate): string {
  if (cert.isExpired) return 'Expired';
  if (cert.isNotYetValid) return 'Not valid yet';
  if (cert.daysUntilExpiry !== null) return `Valid — ${cert.daysUntilExpiry} day${cert.daysUntilExpiry === 1 ? '' : 's'} left`;
  return 'Valid';
}

/** Overview tab: identity, issuer, validity, fingerprints, key, where it was found. */
export function certOverviewSections(cert: ParsedCertificate): CertRowSection[] {
  const sans = cert.extensions.subjectAltNames || [];
  return [
    {
      title: 'Identity',
      rows: [
        { label: 'Subject', value: cert.subject.formatted },
        { label: 'Common name', value: cert.subject.commonName },
        { label: 'Organization', value: cert.subject.organization },
        { label: 'Organizational unit', value: cert.subject.organizationalUnit },
        { label: 'Country', value: cert.subject.country },
        ...(sans.length ? [{ label: 'Subject alt names', value: sans.map((s) => `${s.type}: ${s.value}`).join(', ') }] : []),
      ],
    },
    {
      title: 'Issuer',
      rows: [
        { label: 'Issuer', value: cert.issuer.formatted },
        { label: 'Issuer organization', value: cert.issuer.organization },
        {
          label: 'Relationship',
          value: cert.selfIssued
            ? cert.selfSigned
              ? 'Self-signed — it issued itself'
              : 'Names itself as issuer, but the self-signature does not verify'
            : 'Issued by another certificate',
        },
      ],
    },
    {
      title: 'Validity',
      rows: [
        { label: 'Not before', value: certFormatDate(cert.validFrom) },
        { label: 'Not after', value: certFormatDate(cert.validTo) },
        { label: 'Current status', value: certValidityState(cert) },
      ],
    },
    {
      title: 'Serial & fingerprints',
      rows: [
        { label: 'Serial number', value: cert.serialNumber, mono: true, copy: true },
        { label: 'SHA-256', value: cert.fingerprints.sha256, mono: true, copy: true },
      ],
    },
    {
      title: 'Public key & signature',
      rows: [
        { label: 'Key algorithm', value: cert.publicKey.algorithm },
        { label: 'Key size', value: cert.publicKey.keySize ? `${cert.publicKey.keySize} bits` : null },
        { label: 'Curve', value: cert.publicKey.namedCurve },
        { label: 'Exponent', value: cert.publicKey.exponent },
        { label: 'Signature algorithm', value: cert.signatureAlgorithm.name },
        { label: 'Signature hash', value: cert.signatureAlgorithm.hash },
        { label: 'Version', value: `X.509 v${cert.version}` },
      ],
    },
    {
      title: 'Found in',
      rows: cert.sources.map((s) => ({
        label: SOURCE_KIND_LABEL[s.kind] || s.kind,
        value: s.signatureFieldName ? `Field ${s.signatureFieldName}` : 'Document-level',
      })),
    },
  ];
}

/** The signatures whose chain includes this certificate. */
export function certUsedBy(cert: ParsedCertificate, report: CertificateReport | null): ReportSignature[] {
  return (report?.signatures || []).filter((s) => s.signerCertificateId === cert.id || (s.certificateIds || []).includes(cert.id));
}

export interface CertExtensionRow {
  name: string;
  critical: boolean;
  value: string;
}

/** Extensions tab: only those present; plus whether the CRL/OCSP note applies. */
export function certExtensionRows(cert: ParsedCertificate): { rows: CertExtensionRow[]; revocationNote: boolean } {
  const ext = cert.extensions;
  const rows: CertExtensionRow[] = [];
  const add = (name: string, critical: boolean, value: string | null | undefined) => {
    if (value === null || value === undefined || value === '') return;
    rows.push({ name, critical, value });
  };
  if (ext.basicConstraints) {
    const bc = ext.basicConstraints;
    add(
      'Basic Constraints',
      bc.critical,
      `${bc.isCa ? 'Certificate authority' : 'End-entity certificate'}${bc.pathLenConstraint !== null ? ` · path length limit ${bc.pathLenConstraint}` : ''}`,
    );
  }
  if (ext.keyUsage) add('Key Usage', ext.keyUsage.critical, ext.keyUsage.usages.join(', ') || 'No bits set');
  if (ext.extendedKeyUsage) add('Extended Key Usage', ext.extendedKeyUsage.critical, ext.extendedKeyUsage.names.join(', '));
  add('Subject Key Identifier', false, ext.subjectKeyIdentifier);
  if (ext.authorityKeyIdentifier) {
    const aki = ext.authorityKeyIdentifier;
    add('Authority Key Identifier', false, [aki.keyIdentifier, aki.issuerDn, aki.serial].filter(Boolean).join(' · '));
  }
  if (ext.subjectAltNames?.length) add('Subject Alternative Names', false, ext.subjectAltNames.map((s) => `${s.type}: ${s.value}`).join(', '));
  if (ext.crlDistributionPoints?.length) add('CRL Distribution Points', false, ext.crlDistributionPoints.join(', '));
  if (ext.authorityInfoAccess?.ocsp?.length) add('OCSP responder', false, ext.authorityInfoAccess.ocsp.join(', '));
  if (ext.authorityInfoAccess?.caIssuers?.length) add('CA issuers', false, ext.authorityInfoAccess.caIssuers.join(', '));
  if (ext.certificatePolicies?.length) {
    add('Certificate Policies', false, ext.certificatePolicies.map((p) => (p.cps ? `${p.oid} (${p.cps})` : p.oid)).join(', '));
  }
  if (ext.unrecognizedCritical?.length) add('Critical, not decoded', true, ext.unrecognizedCritical.join(', '));
  return { rows, revocationNote: !!(ext.crlDistributionPoints?.length || ext.authorityInfoAccess?.ocsp?.length) };
}
