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
import PdfRevisionTool from './PdfRevisionTool';
import * as pkijs from 'pkijs';
import * as asn1js from 'asn1js';
import {
  axisOf,
  certificateDisplayName,
  ensureCryptoEngine,
  type ParsedCertificate,
  type ValidationResult,
  type ValidationStatus,
} from './CertificateModel';
import {
  buildChains,
  worstStatus,
  TRUST_NOTE,
  type CertificateChain,
} from './CertificateChain';
import {
  extractCertificateSources,
  findCmsSlot,
  octetStringBytes,
  readCmsFromSlot,
  signedByteRangeSlice,
  type ExtractedSignature,
} from './PdfCertificateExtractor';

/** Which file revision a signature's ByteRange ends at (1-based), out of how many the file has. */
export interface RevisionCoverage {
  /** null when the signed bytes don't end at a revision boundary (or the range is unreadable). */
  coveredRevision: number | null;
  revisionCount: number;
}

export interface ReportSignature extends ExtractedSignature {
  chainId: string | null;
  revisionCoverage: RevisionCoverage;
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
  return { id, label, status, detail, explanation, axis: axisOf(id) };
}

/** What the rest of the file looks like from one signature's point of view. */
interface LaterRevisionContext {
  /** Only whitespace follows the file's last %%EOF, so its tail is a complete revision. */
  fileEndsAtRevision: boolean;
  /** Every signature whose signed bytes end at a revision boundary. */
  laterSignatures: Array<{ fieldName: string; coveredRevision: number }>;
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
  coverage: RevisionCoverage,
  later: LaterRevisionContext,
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

  // ---- what does it cover? ----------------------------------------------
  // Coverage asks only whether the signed bytes are a well-formed prefix of
  // the file: from byte 0 to the end of a revision. Revisions added after that
  // are a separate question (sig.laterChanges below) -- a signature that
  // cleanly covers revision 1 of 3 is not a coverage problem.
  const slot = signature.cmsSlot;
  const signedEnd = slot.byteRange[2] + slot.byteRange[3];
  const laterRevisions =
    coverage.coveredRevision !== null ? coverage.revisionCount - coverage.coveredRevision : 0;
  const coversWholeRevisions =
    !slot.coversWholeFile && coverage.coveredRevision !== null && later.fileEndsAtRevision;
  if (slot.byteRange[0] !== 0) {
    checks.push(
      result(
        'sig.byteRangeCoverage',
        'Coverage',
        'fail',
        `The first ${slot.byteRange[0]} byte(s) of the file are not signed`,
        'A signature’s byte ranges must start at the beginning of the file. This one starts at ' +
          `byte ${slot.byteRange[0]}, so the file header in front of it could be anything.`,
      ),
    );
  } else if (slot.coversWholeFile) {
    checks.push(
      result(
        'sig.byteRangeCoverage',
        'Coverage',
        'pass',
        'Covers the whole document',
        'The two byte ranges this signature covers account for every byte of the file except the ' +
          'signature itself, so nothing lies outside what was signed.' +
          (coverage.coveredRevision !== null
            ? ` The signed bytes end at revision ${coverage.coveredRevision} of ${coverage.revisionCount}.`
            : ''),
      ),
    );
  } else if (coversWholeRevisions) {
    checks.push(
      result(
        'sig.byteRangeCoverage',
        'Coverage',
        'pass',
        `Covers revision ${coverage.coveredRevision} of ${coverage.revisionCount}`,
        `This signature covers the file from its first byte to the end of revision ` +
          `${coverage.coveredRevision}, which is exactly what a signature on an earlier revision ` +
          'looks like. The revisions added afterwards are reported separately under Later changes.',
      ),
    );
  } else {
    checks.push(
      result(
        'sig.byteRangeCoverage',
        'Coverage',
        'warn',
        `${slot.trailingBytes} byte(s) after the signed region`,
        `This signature covers the file up to byte ${signedEnd}, and ${slot.trailingBytes} byte(s) ` +
          'follow it. ' +
          (coverage.coveredRevision !== null
            ? `The signed bytes end at revision ${coverage.coveredRevision} of ${coverage.revisionCount}, ` +
              'but the bytes after the last revision are not a complete incremental update. '
            : 'The signed bytes do not end at a revision boundary of this file. ') +
          'Those bytes are not covered by this signature, and they are not shaped like a normal ' +
          'later revision either.',
      ),
    );
  }

  // ---- what was added after it? -----------------------------------------
  // Only asked when coverage is clean: otherwise the coverage check above has
  // already said what is wrong. PDF Seal does not analyse what later revisions
  // changed, so this stays 'unknown' -- except after a certification that
  // permits no changes at all, where any later revision deserves a look.
  if (coversWholeRevisions && laterRevisions > 0) {
    const noChangesPermitted = signature.docMdpLevel === 1;
    const signedLater = later.laterSignatures
      .filter((s) => s.coveredRevision > coverage.coveredRevision!)
      .map((s) => `revision ${s.coveredRevision} is signed by ${s.fieldName}`);
    checks.push(
      result(
        'sig.laterChanges',
        'Later changes',
        noChangesPermitted ? 'warn' : 'unknown',
        noChangesPermitted
          ? `${laterRevisions} later revision(s) after a no-changes certification`
          : `${laterRevisions} later revision(s), not evaluated`,
        `${laterRevisions} revision(s) were added to the file after this signature. They do not ` +
          'affect what this signature covers, and PDF Seal does not check what they changed — the ' +
          'Versions section shows it.' +
          (signedLater.length ? ` Of those, ${signedLater.join('; ')}.` : '') +
          (noChangesPermitted
            ? ' This is a certifying signature that permits no changes, so anything other than ' +
              'validation data or a document timestamp added afterwards breaks that certification.'
            : ''),
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
  // A document timestamp commits to the document through its TSTInfo's
  // messageImprint; its messageDigest attribute is the hash of that TSTInfo,
  // not of the document, so comparing the document against it would always fail.
  const timestamp = signature.isDocumentTimestamp;
  const expectedDigest = timestamp
    ? signature.messageImprint?.value ?? null
    : signature.signedAttributes.messageDigest;
  const digestAlgorithm = timestamp
    ? signature.messageImprint?.digestAlgorithm ?? null
    : signature.digestAlgorithm;
  const nodeHash = digestAlgorithm ? DIGEST_TO_NODE_HASH[digestAlgorithm] : undefined;

  let digestMatches: boolean | null = null;
  if (!expectedDigest) {
    checks.push(
      result(
        'sig.messageDigest',
        'Document unchanged',
        'unknown',
        timestamp
          ? 'The timestamp’s message imprint could not be read'
          : 'The signature states no message digest',
        timestamp
          ? 'A document timestamp commits to the document through the message imprint inside its ' +
              'TSTInfo, which could not be decoded here, so there is nothing to compare against.'
          : 'Without a messageDigest signed attribute there is nothing to compare the document’s ' +
              'current bytes against.',
      ),
    );
  } else if (!nodeHash || !covered) {
    checks.push(
      result(
        'sig.messageDigest',
        'Document unchanged',
        'unknown',
        `Digest algorithm ${digestAlgorithm ?? 'unknown'} is not supported here`,
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
          ? `The document still matches its ${digestAlgorithm} digest`
          : 'The document no longer matches the digest that was signed',
        (digestMatches
          ? 'The bytes this signature covers were hashed and compared against the digest recorded ' +
            'inside the signature. They match, so the covered content has not changed since signing.'
          : 'The bytes this signature covers no longer hash to the value recorded inside the ' +
            'signature. The document was modified after it was signed.') +
          (timestamp ? ' For a document timestamp, that digest is the TSTInfo’s message imprint.' : ''),
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
    // pkijs reads a TSTInfo straight out of a primitive OCTET STRING, so a
    // document timestamp whose eContent is BER-constructed (chunked) would fail
    // its schema check. Hand it the same bytes in one piece.
    const eContent = signedData.encapContentInfo?.eContent;
    if (timestamp && eContent?.idBlock?.isConstructed) {
      const whole = octetStringBytes(eContent);
      if (whole) signedData.encapContentInfo.eContent = new asn1js.OctetString({ valueHex: whole });
    }
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
  // Time evidence, not a property of the signature: a signature with no
  // timestamp is not a worse signature, it just leaves the signing time
  // unproven. Either way this is 'unknown' on the trust axis. A document
  // timestamp is itself the time evidence, so it gets no such check.
  if (!timestamp) {
    checks.push(
      signature.hasTimestampToken
        ? result(
            'sig.timestamp',
            'Timestamp',
            'unknown',
            'A timestamp is present but was not verified',
            'This signature carries a timestamp token. pdf-seal does not verify the timestamp or the ' +
              'authority that issued it, so the signing time below is still only what the signer claims.',
          )
        : result(
            'sig.timestamp',
            'Timestamp',
            'unknown',
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
    // This only states the permission level. Whether anything added later
    // respects it is sig.laterChanges' question, which is never a pass.
    const grew = !slot.coversWholeFile;
    checks.push(
      result(
        'sig.docMdp',
        'Certifying signature',
        'pass',
        `DocMDP level ${signature.docMdpLevel}`,
        `This is a certifying signature: it states that after it was applied, ${
          meanings[signature.docMdpLevel] ?? 'a restricted set of changes is permitted'
        }.` +
          (grew
            ? ' The file has grown since signing, and PDF Seal does not check those later changes ' +
              'against this permission level — see Later changes.'
            : ''),
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
  signatureCount: number;
  status: ValidationStatus;
}): string {
  if (!report.documentHasSignatures) {
    return report.signatureFieldCount > 0
      ? 'This document has signature fields but has not been signed yet, so it carries no certificates.'
      : 'This document is not signed and carries no certificates.';
  }

  const one = report.signatureCount === 1;
  switch (report.status) {
    case 'pass':
      return `${one ? 'The signature is' : `All ${report.signatureCount} signatures are`} intact and ` +
        'verified against the certificates embedded in this file. Trust was not evaluated.';
    case 'warn':
      return `${one ? 'The signature verifies' : 'The signatures verify'}, with concerns worth reading ` +
        'before relying on this document. Trust was not evaluated.';
    case 'fail':
      return one
        ? 'The signature does not hold up.'
        : 'At least one signature does not hold up.';
    default:
      return one
        ? 'The signature could only be checked in part.'
        : 'At least one signature could only be checked in part.';
  }
}

/**
 * The checks a signature cannot be green without. Each must be present and
 * pass; anything less leaves the verdict 'unknown', never 'pass'.
 */
const CORE_SIGNATURE_CHECKS = [
  'sig.contentsSlot',
  'sig.signerIdentified',
  'sig.messageDigest',
  'sig.cryptographic',
  'chain.validityAtSigningTime',
];

/**
 * One signature's verdict, from every check that bears on it: its own, its
 * chain's, its links' and its chain certificates'. Only 'signature'-axis
 * checks count -- trust, time and revocation are reported beside the verdict,
 * not folded into it.
 *
 *   fail    -- something was checked and did not hold
 *   unknown -- a core check could not be made (unsupported algorithm, ...)
 *   warn    -- everything core passed, with a concern worth reading
 *   pass    -- the covered bytes match, the signature verifies against the
 *              embedded signer certificate, every issuer link present in the
 *              file verifies, and the chain was valid at the claimed signing
 *              time. Says nothing about who the signer is.
 *
 * A non-core 'unknown' (an optional key identifier, a CA without Key Usage, or
 * later revisions PDF Seal does not analyse) does not block a pass.
 */
export function signatureVerdict(checks: ValidationResult[]): ValidationStatus {
  const relevant = checks.filter((c) => c.axis === 'signature');
  if (relevant.some((c) => c.status === 'fail')) return 'fail';
  const coreHolds = CORE_SIGNATURE_CHECKS.every((id) =>
    relevant.some((c) => c.id === id && c.status === 'pass'),
  );
  if (!coreHolds) return 'unknown';
  if (relevant.some((c) => c.status === 'warn')) return 'warn';
  return 'pass';
}

/** Every check that bears on one signature: its own, then its chain's. */
function checksForSignature(
  signatureChecks: ValidationResult[],
  chain: CertificateChain | undefined,
  certificatesById: Map<string, ParsedCertificate>,
): ValidationResult[] {
  if (!chain) return signatureChecks;
  return [
    ...signatureChecks,
    ...chain.checks,
    ...chain.links.flatMap((link) => link.checks),
    ...chain.certificateIds.flatMap((id) => certificatesById.get(id)?.checks ?? []),
  ];
}

/**
 * Which revision the signature's signed bytes (ByteRange end = c + d) finish
 * at. Only whitespace may sit between that revision's `%%EOF` and the range
 * end (signers include the trailing EOL); anything else is "no boundary".
 */
function coverageFor(signature: ExtractedSignature, ends: number[], bytes: Uint8Array): RevisionCoverage {
  const br = signature.cmsSlot?.byteRange;
  const revisionCount = ends.length;
  if (!br) return { coveredRevision: null, revisionCount };
  const signedEnd = br[2] + br[3];
  const i = ends.findIndex((end) => {
    if (end > signedEnd) return false;
    for (let p = end; p < signedEnd; p++) {
      if (bytes[p] !== 0x0a && bytes[p] !== 0x0d && bytes[p] !== 0x20) return false;
    }
    return true;
  });
  return { coveredRevision: i === -1 ? null : i + 1, revisionCount };
}

/** Only whitespace follows the file's last revision, so its tail is a complete revision. */
function endsAtRevision(ends: number[], bytes: Uint8Array): boolean {
  if (ends.length === 0) return false;
  for (let p = ends[ends.length - 1]; p < bytes.length; p++) {
    if (bytes[p] !== 0x0a && bytes[p] !== 0x0d && bytes[p] !== 0x20) return false;
  }
  return true;
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
        // signed data even if neither is proven. A document timestamp's time
        // is its own genTime, which its (verified) signature covers.
        signingTime: s.isDocumentTimestamp
          ? s.timestampTime
          : s.signedAttributes.signingTime ?? s.signingTimeClaimed ?? null,
        purpose: s.isDocumentTimestamp ? ('documentTimestamp' as const) : ('signature' as const),
      })),
  );

  const revisionEnds = PdfRevisionTool.findRevisionBoundaries(bytes).map((b) => b.endOffset);
  const coverages = extraction.signatures.map((s) => coverageFor(s, revisionEnds, bytes));
  const later: LaterRevisionContext = {
    fileEndsAtRevision: endsAtRevision(revisionEnds, bytes),
    laterSignatures: extraction.signatures.flatMap((s, i) =>
      coverages[i].coveredRevision !== null
        ? [{ fieldName: s.fieldName, coveredRevision: coverages[i].coveredRevision! }]
        : [],
    ),
  };

  const signatures: ReportSignature[] = [];
  for (const [i, signature] of extraction.signatures.entries()) {
    const revisionCoverage = coverages[i];
    const checks = await checkSignature(signature, bytes, certificatesById, revisionCoverage, later);
    const chain = chains.find((c) => c.signatureFieldName === signature.fieldName);
    signatures.push({
      ...signature,
      chainId: chain?.id ?? null,
      revisionCoverage,
      checks,
      status: signatureVerdict(checksForSignature(checks, chain, certificatesById)),
    });
  }

  // ---- roll everything up ----------------------------------------------
  // The counts cover every check in the report, diagnostics included, so the
  // list the panel shows always adds up. The verdict does not: it is the worst
  // of the signatures' own verdicts, so a certificate no signature relies on,
  // or a trust question nobody could answer, never colours it.
  const everyCheck = collectAllChecks({ signatures, chains, certificates });

  const counts = { pass: 0, warn: 0, fail: 0, unknown: 0 };
  for (const check of everyCheck) counts[check.status]++;

  const status = worstStatus(signatures.map((s) => s.status));

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
        signatureCount: signatures.length,
        status,
      }),
      counts,
    },
    warnings,
    truncated,
  };
}

export default { buildCertificateReport };
