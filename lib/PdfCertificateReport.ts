// Composes the single object the Certificates panel renders.
//
// Everything the browser shows comes from here: it holds no certificate
// knowledge of its own, and every label, verdict and explanation it prints is a
// string this file produced. That is deliberate -- it keeps the parsing and
// judging in one testable place, and it means the UI cannot quietly claim
// something that was never checked.
//
// This file also owns the per-signature checks, because they are the only ones
// that need the file's bytes as well as its certificates. The two that matter
// most are kept separate on purpose:
//
//   sig.messageDigest  -- do the document's bytes still hash to what the
//                         signature committed to?
//   sig.cryptographic  -- does the signature over those signed attributes
//                         verify against the signer's public key?
//
// Digest fails => the document was edited after signing.
// Digest passes but signature fails => the document is intact and the signature
// blob itself was altered -- which is exactly what this feature's own modifier
// produces when it replaces a signer certificate.

import { createHash } from 'node:crypto';
import * as pkijs from 'pkijs';
import {
  certificateDisplayName,
  ensureCryptoEngine,
  type ParsedCertificate,
  type ValidationResult,
  type ValidationStatus,
} from './CertificateModel';
import {
  buildChains,
  rollUp,
  worstStatus,
  TRUST_NOTE,
  type CertificateChain,
} from './CertificateChain';
import {
  extractCertificateSources,
  findCmsSlot,
  readCmsFromSlot,
  signedByteRangeSlice,
  type ExtractedSignature,
} from './PdfCertificateExtractor';

export interface ReportSignature extends ExtractedSignature {
  chainId: string | null;
  checks: ValidationResult[];
  status: ValidationStatus;
}

export interface CertificateReport {
  generatedAt: string;
  documentHasSignatures: boolean;
  signatureFieldCount: number;
  unsignedSignatureFieldNames: string[];
  signatures: ReportSignature[];
  certificates: ParsedCertificate[];
  chains: CertificateChain[];
  /** Certificates present in the file that no signature reaches. */
  unchainedCertificateIds: string[];
  trust: { hasTrustStore: false; note: string };
  summary: {
    status: ValidationStatus;
    headline: string;
    counts: { pass: number; warn: number; fail: number; unknown: number };
  };
  warnings: string[];
  truncated: boolean;
}

/** A PAdES LTV file can carry a lot; past this the list stops being useful. */
const MAX_CERTIFICATES = 100;

const DIGEST_TO_NODE_HASH: Record<string, string> = {
  'SHA-1': 'sha1',
  'SHA-224': 'sha224',
  'SHA-256': 'sha256',
  'SHA-384': 'sha384',
  'SHA-512': 'sha512',
};

function result(
  id: string,
  label: string,
  status: ValidationStatus,
  detail: string,
  explanation: string,
): ValidationResult {
  return { id, label, status, detail, explanation };
}

/**
 * Check one signature against the file it lives in.
 *
 * `certificatesById` is the whole document's certificate set, since a signature
 * may be covered by /DSS material rather than by its own CMS.
 */
async function checkSignature(
  signature: ExtractedSignature,
  bytes: Uint8Array,
  certificatesById: Map<string, ParsedCertificate>,
): Promise<ValidationResult[]> {
  const checks: ValidationResult[] = [];

  // ---- can we even see the signature content? ---------------------------
  if (signature.cmsError || !signature.cmsSlot) {
    checks.push(
      result(
        'sig.contentsSlot',
        'Signature content',
        'fail',
        signature.cmsError ?? 'The signature content could not be located',
        'The bytes holding this signature could not be read, so nothing about the signature ' +
          'itself can be checked.',
      ),
    );
    return checks;
  }

  const indefinite = signature.cmsSlot.encoding === 'indefinite';
  checks.push(
    result(
      'sig.contentsSlot',
      'Signature content',
      'pass',
      `${signature.cmsSlot.derLength} bytes in a ${signature.cmsSlot.capacityBytes}-byte slot` +
        (indefinite ? ' (BER indefinite-length)' : ''),
      'The signature content was found where /ByteRange says it is, and decoded as CMS SignedData.' +
        (indefinite
          ? ' It is written with BER indefinite lengths rather than DER, which is permitted for ' +
            'CMS and is what streaming signers produce.'
          : ''),
    ),
  );

  // ---- does it cover the whole file? ------------------------------------
  const slot = signature.cmsSlot;
  if (slot.coversWholeFile) {
    checks.push(
      result(
        'sig.byteRangeCoverage',
        'Coverage',
        'pass',
        'Covers the whole document',
        'The two byte ranges this signature covers account for every byte of the file except the ' +
          'signature itself, so nothing lies outside what was signed.',
      ),
    );
  } else {
    checks.push(
      result(
        'sig.byteRangeCoverage',
        'Coverage',
        'warn',
        `${slot.trailingBytes} byte(s) after the signed region`,
        `This signature covers the file up to byte ${slot.byteRange[2] + slot.byteRange[3]}, and ` +
          `${slot.trailingBytes} byte(s) follow it. That is normally a later incremental update — ` +
          'the Revisions section shows what changed — but those bytes are not covered by this ' +
          'signature.',
      ),
    );
  }

  // ---- which certificate signed it? -------------------------------------
  const signerCert = signature.signerCertificateId
    ? certificatesById.get(signature.signerCertificateId)
    : undefined;
  if (signerCert) {
    checks.push(
      result(
        'sig.signerIdentified',
        'Signer certificate',
        'pass',
        signerCert.subject.commonName ?? signerCert.subject.formatted,
        signature.signerSid
          ? `The signature names its signer by ${
              signature.signerSid.type === 'issuerAndSerial'
                ? 'issuer and serial number'
                : 'subject key identifier'
            }, and exactly one embedded certificate matches.`
          : 'The signature does not name its signer explicitly, but only one embedded certificate ' +
              'could be the signer.',
      ),
    );
  } else {
    checks.push(
      result(
        'sig.signerIdentified',
        'Signer certificate',
        'fail',
        'Not found in this document',
        'The certificate that made this signature is not embedded in the PDF, so the signature ' +
          'cannot be verified from the file alone.',
      ),
    );
  }

  // ---- the two checks that matter ---------------------------------------
  const cms = readCmsFromSlot(bytes, slot);
  const covered = signature.byteRange ? signedByteRangeSlice(bytes, signature.byteRange) : null;
  const expectedDigest = signature.signedAttributes.messageDigest;
  const nodeHash = signature.digestAlgorithm
    ? DIGEST_TO_NODE_HASH[signature.digestAlgorithm]
    : undefined;

  let digestMatches: boolean | null = null;
  if (!expectedDigest) {
    checks.push(
      result(
        'sig.messageDigest',
        'Document unchanged',
        'unknown',
        'The signature states no message digest',
        'Without a messageDigest signed attribute there is nothing to compare the document’s ' +
          'current bytes against.',
      ),
    );
  } else if (!nodeHash || !covered) {
    checks.push(
      result(
        'sig.messageDigest',
        'Document unchanged',
        'unknown',
        `Digest algorithm ${signature.digestAlgorithm ?? 'unknown'} is not supported here`,
        'The document’s bytes could not be hashed with the algorithm this signature used, so the ' +
          'comparison could not be made. That is not the same as the document having changed.',
      ),
    );
  } else {
    const actual = createHash(nodeHash).update(covered).digest('hex').toUpperCase();
    digestMatches = actual === expectedDigest.toUpperCase();
    checks.push(
      result(
        'sig.messageDigest',
        'Document unchanged',
        digestMatches ? 'pass' : 'fail',
        digestMatches
          ? `The document still matches its ${signature.digestAlgorithm} digest`
          : 'The document no longer matches the digest that was signed',
        digestMatches
          ? 'The bytes this signature covers were hashed and compared against the digest recorded ' +
              'inside the signature. They match, so the covered content has not changed since signing.'
          : 'The bytes this signature covers no longer hash to the value recorded inside the ' +
              'signature. The document was modified after it was signed.',
      ),
    );
  }

  if (!cms) {
    checks.push(
      result(
        'sig.cryptographic',
        'Signature',
        'unknown',
        'The signature content could not be read',
        'The cryptographic check needs the signature bytes, which could not be recovered.',
      ),
    );
    return checks;
  }

  let verified: boolean | null = null;
  let verifyError = '';
  try {
    const signedData = new pkijs.SignedData({
      schema: pkijs.ContentInfo.fromBER(cms).content,
    });
    const data = covered
      ? covered.buffer.slice(covered.byteOffset, covered.byteOffset + covered.byteLength)
      : undefined;
    const outcome: any = await signedData.verify({
      signer: 0,
      data,
      // Chain and trust are this application's job, deliberately. pkijs's chain
      // engine wants trust anchors and folds trust into its verdict, which is
      // the one thing this feature must not do.
      checkChain: false,
      extendedMode: true,
    } as any);
    verified = typeof outcome === 'boolean' ? outcome : outcome?.signatureVerified === true;
  } catch (error: any) {
    // pkijs throws rather than returning false when the message digest does not
    // match, so the error text has to be read to tell the two failures apart.
    verifyError = String(error?.message ?? error);
    verified = false;
  }

  const digestCausedIt = digestMatches === false || /message digest/i.test(verifyError);
  if (verified) {
    checks.push(
      result(
        'sig.cryptographic',
        'Signature',
        'pass',
        signerCert
          ? `Verified against ${signerCert.subject.commonName ?? signerCert.subject.formatted}`
          : 'Cryptographically verified',
        'The signature over this signature’s signed attributes verifies against the signer ' +
          'certificate’s public key, and those attributes commit to the document’s content. This ' +
          'is a real cryptographic check — but it proves nothing about who the signer is, only ' +
          'that whoever holds that key made this signature.',
      ),
    );
  } else if (digestCausedIt) {
    checks.push(
      result(
        'sig.cryptographic',
        'Signature',
        'fail',
        'The document changed after signing',
        'The signature could not be verified because the document no longer matches the digest it ' +
          'committed to. The signature blob itself may still be intact — the content around it is ' +
          'what changed.',
      ),
    );
  } else {
    checks.push(
      result(
        'sig.cryptographic',
        'Signature',
        'fail',
        'The signature does not verify',
        'The document still matches the digest that was signed, but the signature over those ' +
          'signed attributes does not verify against the signer certificate’s key. That points at ' +
          'the signature blob having been altered rather than the document.' +
          (verifyError ? ` The verifier reported: ${verifyError}` : ''),
      ),
    );
  }

  // ---- what we will not claim -------------------------------------------
  if (signature.hasTimestampToken) {
    checks.push(
      result(
        'sig.timestamp',
        'Timestamp',
        'unknown',
        'A timestamp is present but was not verified',
        'This signature carries a timestamp token. pdf-seal does not verify the timestamp or the ' +
          'authority that issued it, so the signing time below is still only what the signer claims.',
      ),
    );
  } else {
    checks.push(
      result(
        'sig.timestamp',
        'Timestamp',
        'warn',
        'No timestamp',
        'Nothing independently attests to when this signature was made, so the signing time is ' +
          'the signer’s own claim and could be anything.',
      ),
    );
  }

  // ---- informational ----------------------------------------------------
  if (signature.docMdpLevel !== null) {
    const meanings: Record<number, string> = {
      1: 'no changes are permitted',
      2: 'form filling and signing are permitted',
      3: 'form filling, signing and annotations are permitted',
    };
    checks.push(
      result(
        'sig.docMdp',
        'Certifying signature',
        'pass',
        `DocMDP level ${signature.docMdpLevel}`,
        `This is a certifying signature: it states that after it was applied, ${
          meanings[signature.docMdpLevel] ?? 'a restricted set of changes is permitted'
        }.`,
      ),
    );
  }

  if (signature.subFilter === 'adbe.x509.rsa_sha1') {
    checks.push(
      result(
        'sig.legacySubFilter',
        'Signature format',
        'warn',
        'adbe.x509.rsa_sha1 is deprecated',
        'This signature uses the legacy adbe.x509.rsa_sha1 format, where the certificate lives in ' +
          '/Cert rather than in a CMS structure. Modern verifiers may not accept it.',
      ),
    );
  }

  return checks;
}

export interface CheckSource {
  kind: 'signature' | 'chain' | 'link' | 'certificate';
  /** Short human label, e.g. 'Signature: Signature1' or 'CN=Example Issuing CA'. */
  label: string;
  certificateId?: string | null;
  signatureFieldName?: string | null;
}

export type SourcedCheck = ValidationResult & { source: CheckSource };

/**
 * Flatten every check in the report into one list, tagged with where it came
 * from. This is the single traversal that `summary.counts` is derived from, so
 * the count the panel headlines can never disagree with the checks the panel
 * lists -- both come from calling this exact function.
 *
 * Traversal order is signatures -> chains -> chain links -> certificates, and
 * must stay in that order: it is what `counts` and `summary.status` were
 * computed over historically, and reordering it would not change the numbers
 * but would be a needless diff against every existing expectation of "the same
 * checks in the same order".
 */
export function collectAllChecks(
  report: Pick<CertificateReport, 'signatures' | 'chains' | 'certificates'>,
): SourcedCheck[] {
  const certificatesById = new Map(report.certificates.map((c) => [c.id, c]));
  const withSource = (checks: ValidationResult[], source: CheckSource): SourcedCheck[] =>
    checks.map((check) => ({ ...check, source }));

  const all: SourcedCheck[] = [];

  for (const signature of report.signatures) {
    all.push(
      ...withSource(signature.checks, {
        kind: 'signature',
        label: `Signature: ${signature.fieldName}`,
        signatureFieldName: signature.fieldName,
      }),
    );
  }

  for (const chain of report.chains) {
    const leaf = chain.certificateIds[0] ? certificatesById.get(chain.certificateIds[0]) : undefined;
    const chainLabel = leaf ? certificateDisplayName(leaf) : chain.signatureFieldName ?? chain.id;
    all.push(
      ...withSource(chain.checks, {
        kind: 'chain',
        label: `Chain: ${chainLabel}`,
        signatureFieldName: chain.signatureFieldName,
      }),
    );
    for (const link of chain.links) {
      const subject = certificatesById.get(link.subjectId);
      all.push(
        ...withSource(link.checks, {
          kind: 'link',
          label: subject ? certificateDisplayName(subject) : link.subjectId,
          certificateId: link.subjectId,
          signatureFieldName: chain.signatureFieldName,
        }),
      );
    }
  }

  for (const cert of report.certificates) {
    all.push(
      ...withSource(cert.checks, {
        kind: 'certificate',
        label: certificateDisplayName(cert),
        certificateId: cert.id,
      }),
    );
  }

  return all;
}

function buildHeadline(report: {
  documentHasSignatures: boolean;
  signatureFieldCount: number;
  certificates: ParsedCertificate[];
  status: ValidationStatus;
}): string {
  if (!report.documentHasSignatures) {
    return report.signatureFieldCount > 0
      ? 'This document has signature fields but has not been signed yet, so it carries no certificates.'
      : 'This document is not signed and carries no certificates.';
  }

  const certCount = report.certificates.length;
  const certs = `${certCount} certificate${certCount === 1 ? '' : 's'}`;
  switch (report.status) {
    case 'pass':
      return `Everything that could be checked about these ${certs} passed. Trust was not evaluated.`;
    case 'warn':
      return `These ${certs} raised warnings worth reading before relying on this document.`;
    case 'fail':
      return `Something is wrong with these ${certs} or the signatures using them.`;
    default:
      return `These ${certs} could only be checked in part.`;
  }
}

/**
 * Read a PDF and produce the whole certificate report for it.
 *
 * Never throws for a document-shaped reason: an unopenable file, an unsigned
 * file and a file whose signatures are broken all come back as a report saying
 * so, because "there is nothing here" and "there is something wrong here" are
 * both answers the panel needs to show.
 */
export async function buildCertificateReport(bytes: Uint8Array): Promise<CertificateReport> {
  ensureCryptoEngine();

  const extraction = await extractCertificateSources(bytes);
  const warnings = [...extraction.warnings];

  let certificates = extraction.certificates;
  let truncated = false;
  if (certificates.length > MAX_CERTIFICATES) {
    truncated = true;
    warnings.push(
      `This document contains ${certificates.length} certificates; only the first ${MAX_CERTIFICATES} are listed.`,
    );
    certificates = certificates.slice(0, MAX_CERTIFICATES);
  }

  const certificatesById = new Map(certificates.map((c) => [c.id, c]));

  // Chains first: they assign each certificate its role, which the
  // per-certificate checks depend on to know what to expect of it.
  const { chains, unchainedIds } = buildChains(
    certificates,
    extraction.signatures
      .filter((s) => s.signerCertificateId)
      .map((s) => ({
        certificateId: s.signerCertificateId!,
        signatureFieldName: s.fieldName,
        // The claimed signing time, preferring the signed attribute over the
        // signature dictionary's /M, since the former is at least inside the
        // signed data even if neither is proven.
        signingTime: s.signedAttributes.signingTime ?? s.signingTimeClaimed ?? null,
      })),
  );

  const signatures: ReportSignature[] = [];
  for (const signature of extraction.signatures) {
    const checks = await checkSignature(signature, bytes, certificatesById);
    const chain = chains.find((c) => c.signatureFieldName === signature.fieldName);
    signatures.push({
      ...signature,
      chainId: chain?.id ?? null,
      checks,
      status: rollUp(checks),
    });
  }

  // ---- roll everything up ----------------------------------------------
  const everyCheck = collectAllChecks({ signatures, chains, certificates });

  const counts = { pass: 0, warn: 0, fail: 0, unknown: 0 };
  for (const check of everyCheck) counts[check.status]++;

  // 'unknown' is excluded from the headline verdict on purpose: trust and
  // revocation are always unknown by design, so including them would make every
  // document, however clean, report as unresolved.
  const status = extraction.signatures.length === 0
    ? 'unknown'
    : worstStatus(everyCheck.map((c) => c.status).filter((s) => s !== 'unknown'));

  const documentHasSignatures = extraction.signatures.length > 0;

  return {
    generatedAt: new Date().toISOString(),
    documentHasSignatures,
    signatureFieldCount: extraction.signatureFieldCount,
    unsignedSignatureFieldNames: extraction.unsignedSignatureFieldNames,
    signatures,
    certificates,
    chains,
    unchainedCertificateIds: unchainedIds,
    trust: { hasTrustStore: false, note: TRUST_NOTE },
    summary: {
      status,
      headline: buildHeadline({
        documentHasSignatures,
        signatureFieldCount: extraction.signatureFieldCount,
        certificates,
        status,
      }),
      counts,
    },
    warnings,
    truncated,
  };
}

export default { buildCertificateReport };
