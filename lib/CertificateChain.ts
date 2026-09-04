// Judges certificates: what is wrong with each one, whether each link in a
// chain actually holds, and how far the chain reaches.
//
// The one rule this file exists to enforce is that a result is never claimed
// unless it was computed. There is no trust store here and there is no network
// access, so three things stay rigorously separate:
//
//   structurally valid  -- the ASN.1 parsed and the fields make sense
//   cryptographically valid -- verify() said yes against a key in this file
//   trusted             -- never evaluated; always reported as 'unknown'
//
// The cryptographic issuer check is Node's X509Certificate.verify(), not pkijs's
// CertificateChainValidationEngine. The pkijs engine wants a trust-anchor list
// and folds trust into its verdict, which would blur the exact line above.

import { X509Certificate } from 'node:crypto';
import {
  certificateDisplayName,
  type ParsedCertificate,
  type ValidationResult,
  type ValidationStatus,
} from './CertificateModel';

export interface ChainLink {
  subjectId: string;
  issuerId: string;
  checks: ValidationResult[];
}

export interface CertificateChain {
  id: string;
  signatureFieldName: string | null;
  /** Leaf first, then each issuer in turn. */
  certificateIds: string[];
  links: ChainLink[];
  /** The chain ends at a self-signed certificate that is present in the file. */
  complete: boolean;
  /** Index into certificateIds where the chain stops, or null when complete. */
  brokenAtIndex: number | null;
  /** Issuer DN the chain needs but the file does not contain. */
  missingIssuerDn: string | null;
  checks: ValidationResult[];
}

export interface CertificateChainContext {
  /** Claimed signing time, ISO-8601. Claimed, not proven -- there is no verified timestamp. */
  signingTime?: string | null;
}

/** Days before expiry at which a still-valid certificate starts warning. */
const EXPIRY_WARNING_DAYS = 30;

/** EKUs that make sense on a document signer. Anything else warns, never fails. */
const DOCUMENT_SIGNING_EKUS = new Set([
  '2.5.29.37.0', // anyExtendedKeyUsage
  '1.3.6.1.5.5.7.3.4', // emailProtection -- what most PDF signers actually carry
  '1.3.6.1.5.5.7.3.36', // documentSigning
  '1.2.840.113583.1.1.5', // Adobe authentic document
]);

const WEAK_SIGNATURE_HASHES = new Set(['MD5', 'SHA-1']);

const NO_TRUST_STORE_NOTE =
  'pdf-seal has no trust store. It ships no list of trusted root CAs and never contacts a CA, ' +
  'CRL responder or OCSP responder. Everything here is checked against the certificates embedded ' +
  'in this file only — a perfect result does not mean the signer is who they say they are.';

export const TRUST_NOTE = NO_TRUST_STORE_NOTE;

function result(
  id: string,
  label: string,
  status: ValidationStatus,
  detail: string,
  explanation: string,
): ValidationResult {
  return { id, label, status, detail, explanation };
}

/** Worst status wins, so a roll-up never reads better than its parts. */
export function worstStatus(statuses: ValidationStatus[]): ValidationStatus {
  if (statuses.includes('fail')) return 'fail';
  if (statuses.includes('warn')) return 'warn';
  if (statuses.includes('unknown')) return 'unknown';
  return statuses.length > 0 ? 'pass' : 'unknown';
}

export function rollUp(checks: ValidationResult[]): ValidationStatus {
  return worstStatus(checks.map((c) => c.status));
}

function toX509(cert: ParsedCertificate): X509Certificate | null {
  if (cert.parseError) return null;
  try {
    return new X509Certificate(Buffer.from(cert.derBase64, 'base64'));
  } catch {
    return null;
  }
}

function formatDate(iso: string): string {
  if (!iso) return 'unknown';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? 'unknown' : date.toISOString().slice(0, 10);
}

/* ---------------------------------------------------------------------------
   Per-certificate checks
   ------------------------------------------------------------------------ */

export function checkCertificate(
  cert: ParsedCertificate,
  context: CertificateChainContext = {},
): ValidationResult[] {
  const checks: ValidationResult[] = [];
  const role = cert.role;
  const name = certificateDisplayName(cert);

  // ---- structure -------------------------------------------------------
  if (cert.parseError) {
    checks.push(
      result(
        'cert.parse',
        'Structure',
        'fail',
        cert.parseError,
        'The bytes found in the PDF could not be decoded as an X.509 certificate, so nothing ' +
          'further about this entry can be checked.',
      ),
    );
    return checks;
  }
  checks.push(
    result(
      'cert.parse',
      'Structure',
      'pass',
      `Parsed as an X.509 v${cert.version} certificate`,
      'The certificate decoded cleanly with both pkijs and Node’s X.509 parser.',
    ),
  );

  // ---- validity window -------------------------------------------------
  const from = formatDate(cert.validFrom);
  const to = formatDate(cert.validTo);
  if (cert.isExpired) {
    checks.push(
      result(
        'cert.validity.window',
        'Validity period',
        'fail',
        `Expired on ${to}`,
        `This certificate was valid from ${from} to ${to}. That end date is in the past, so it is ` +
          'no longer valid today. For a document signed before it expired this may be expected — ' +
          'see the separate check against the claimed signing time.',
      ),
    );
  } else if (cert.isNotYetValid) {
    checks.push(
      result(
        'cert.validity.window',
        'Validity period',
        'fail',
        `Not valid until ${from}`,
        `This certificate does not become valid until ${from}, which is in the future.`,
      ),
    );
  } else if (cert.daysUntilExpiry !== null && cert.daysUntilExpiry <= EXPIRY_WARNING_DAYS) {
    checks.push(
      result(
        'cert.validity.window',
        'Validity period',
        'warn',
        `Expires in ${cert.daysUntilExpiry} day${cert.daysUntilExpiry === 1 ? '' : 's'} (${to})`,
        `Valid from ${from} to ${to}. It is still valid now, but expires within ${EXPIRY_WARNING_DAYS} days.`,
      ),
    );
  } else {
    checks.push(
      result(
        'cert.validity.window',
        'Validity period',
        'pass',
        `Valid from ${from} to ${to}`,
        'The current date falls inside the certificate’s validity period.',
      ),
    );
  }

  // ---- validity at the claimed signing time ----------------------------
  // Kept separate from the check above on purpose: an expired certificate that
  // was valid when the document was signed is the normal state of any older
  // signed PDF, and must not read as a red failure.
  if (context.signingTime) {
    const signedAt = new Date(context.signingTime);
    const notBefore = new Date(cert.validFrom);
    const notAfter = new Date(cert.validTo);
    if (Number.isNaN(signedAt.getTime())) {
      checks.push(
        result(
          'cert.validity.atSigningTime',
          'Valid at claimed signing time',
          'unknown',
          'The signing time could not be read',
          'The signature carries a signing time that is not a date we can parse.',
        ),
      );
    } else {
      const inWindow = signedAt >= notBefore && signedAt <= notAfter;
      checks.push(
        result(
          'cert.validity.atSigningTime',
          'Valid at claimed signing time',
          inWindow ? 'pass' : 'fail',
          inWindow
            ? `Valid on ${formatDate(context.signingTime)}`
            : `Not valid on ${formatDate(context.signingTime)}`,
          `The signature claims it was made on ${formatDate(context.signingTime)}, which ${
            inWindow ? 'falls inside' : 'falls outside'
          } this certificate’s validity period of ${from} to ${to}. That signing time is claimed by ` +
            'the signer and is not proven — only a verified timestamp could prove it.',
        ),
      );
    }
  } else {
    checks.push(
      result(
        'cert.validity.atSigningTime',
        'Valid at claimed signing time',
        'unknown',
        'No signing time available',
        'The signature does not state when it was made, so we cannot check whether this ' +
          'certificate was valid at that moment.',
      ),
    );
  }

  // ---- basic constraints ------------------------------------------------
  const bc = cert.extensions.basicConstraints;
  const isCaRole = role === 'intermediate' || role === 'root';
  if (isCaRole) {
    if (!bc) {
      checks.push(
        result(
          'cert.basicConstraints',
          'Basic Constraints',
          'fail',
          'Missing on a CA certificate',
          'This certificate issued another certificate, but it carries no Basic Constraints ' +
            'extension. RFC 5280 requires a CA to declare itself with cA=true.',
        ),
      );
    } else if (!bc.isCa) {
      checks.push(
        result(
          'cert.basicConstraints',
          'Basic Constraints',
          'fail',
          'cA=false on a CA certificate',
          'This certificate issued another certificate, but its Basic Constraints say it is not a ' +
            'CA. It is not permitted to sign certificates.',
        ),
      );
    } else {
      checks.push(
        result(
          'cert.basicConstraints',
          'Basic Constraints',
          'pass',
          bc.pathLenConstraint === null
            ? 'cA=true, no path length limit'
            : `cA=true, path length limit ${bc.pathLenConstraint}`,
          'The certificate declares itself a certificate authority, so it is allowed to issue the ' +
            'certificate below it.',
        ),
      );
    }
  } else if (role === 'signer') {
    if (bc?.isCa) {
      checks.push(
        result(
          'cert.basicConstraints',
          'Basic Constraints',
          'warn',
          'cA=true on a signing certificate',
          'This certificate signed the document but also declares itself a certificate authority. ' +
            'That is unusual — signing keys and issuing keys are normally kept separate.',
        ),
      );
    } else {
      checks.push(
        result(
          'cert.basicConstraints',
          'Basic Constraints',
          'pass',
          bc ? 'cA=false' : 'Not present (treated as an end-entity certificate)',
          'The certificate is an end-entity certificate, which is what a document signer should be.',
        ),
      );
    }
  }

  // ---- key usage --------------------------------------------------------
  const ku = cert.extensions.keyUsage;
  if (role === 'signer') {
    if (!ku) {
      checks.push(
        result(
          'cert.keyUsage',
          'Key Usage',
          'pass',
          'Not present (no restriction stated)',
          'The certificate states no Key Usage restriction, so it is not restricted from signing.',
        ),
      );
    } else {
      const canSign =
        ku.usages.includes('digitalSignature') || ku.usages.includes('contentCommitment');
      checks.push(
        result(
          'cert.keyUsage',
          'Key Usage',
          canSign ? 'pass' : ku.critical ? 'fail' : 'warn',
          canSign
            ? `Permits signing (${ku.usages.join(', ')})`
            : `Does not permit signing (${ku.usages.join(', ') || 'no bits set'})`,
          canSign
            ? 'The Key Usage extension includes digitalSignature or contentCommitment, so this key ' +
                'is allowed to sign documents.'
            : `The Key Usage extension does not include digitalSignature or contentCommitment. ${
                ku.critical
                  ? 'It is marked critical, so a conforming verifier must reject this signature.'
                  : 'It is not marked critical, so verifiers may differ on whether to accept it.'
              }`,
        ),
      );
    }
  } else if (isCaRole) {
    if (!ku) {
      checks.push(
        result(
          'cert.keyUsage',
          'Key Usage',
          'unknown',
          'Not present',
          'This CA states no Key Usage restriction, so whether it may sign certificates cannot be ' +
            'confirmed from the certificate itself.',
        ),
      );
    } else {
      const canSignCerts = ku.usages.includes('keyCertSign');
      checks.push(
        result(
          'cert.keyUsage',
          'Key Usage',
          canSignCerts ? 'pass' : 'fail',
          canSignCerts ? 'Permits certificate signing' : 'Does not permit certificate signing',
          canSignCerts
            ? 'The Key Usage extension includes keyCertSign, so this CA is allowed to issue the ' +
                'certificate below it.'
            : 'The Key Usage extension omits keyCertSign, so this certificate is not permitted to ' +
                'issue other certificates, yet it appears in the chain as an issuer.',
        ),
      );
    }
  }

  // ---- extended key usage ----------------------------------------------
  // Never a failure: which EKU a document signer should carry varies between
  // Adobe, eIDAS and everyone else, so an unexpected value is worth noting and
  // not worth rejecting.
  if (role === 'signer') {
    const eku = cert.extensions.extendedKeyUsage;
    if (!eku || eku.oids.length === 0) {
      checks.push(
        result(
          'cert.eku',
          'Extended Key Usage',
          'pass',
          'Not present (no restriction stated)',
          'The certificate states no Extended Key Usage, so it is not restricted to a particular purpose.',
        ),
      );
    } else {
      const suitable = eku.oids.some((oid) => DOCUMENT_SIGNING_EKUS.has(oid));
      checks.push(
        result(
          'cert.eku',
          'Extended Key Usage',
          suitable ? 'pass' : 'warn',
          eku.names.join(', '),
          suitable
            ? 'The Extended Key Usage includes a purpose appropriate to signing documents.'
            : 'None of the listed purposes is one commonly used for document signing. Practice ' +
                'varies between issuers, so this is worth noticing rather than treating as invalid.',
        ),
      );
    }
  }

  // ---- self-signed ------------------------------------------------------
  if (cert.selfIssued) {
    if (role === 'root') {
      checks.push(
        result(
          'cert.selfSigned',
          'Self-signed',
          cert.selfSigned ? 'pass' : 'fail',
          cert.selfSigned ? 'Signature verifies against its own key' : 'Self-signature does not verify',
          cert.selfSigned
            ? 'This is a root certificate: its subject and issuer are the same and it verifies ' +
                'against its own public key, as a root should.'
            : 'This certificate names itself as its own issuer, but it does not verify against its ' +
                'own public key. It is not a valid self-signed certificate.',
        ),
      );
    } else {
      checks.push(
        result(
          'cert.selfSigned',
          'Self-signed',
          'warn',
          'Subject and issuer are the same',
          `${name} was not issued by a certificate authority — it vouches only for itself. Nothing ` +
            'independent attests to the identity in it.',
        ),
      );
    }
  }

  // ---- algorithm and key strength ---------------------------------------
  if (cert.signatureAlgorithm.hash && WEAK_SIGNATURE_HASHES.has(cert.signatureAlgorithm.hash)) {
    checks.push(
      result(
        'cert.signatureAlgorithm',
        'Signature algorithm',
        'warn',
        `${cert.signatureAlgorithm.name} uses ${cert.signatureAlgorithm.hash}`,
        `${cert.signatureAlgorithm.hash} is no longer considered collision-resistant. A signature ` +
          'made with it should not be relied on for new documents.',
      ),
    );
  }
  if (cert.publicKey.algorithm === 'rsa' && cert.publicKey.keySize !== null && cert.publicKey.keySize < 2048) {
    checks.push(
      result(
        'cert.keyStrength',
        'Key strength',
        'warn',
        `RSA ${cert.publicKey.keySize} bits`,
        'RSA keys below 2048 bits are below current guidance and should not be relied on.',
      ),
    );
  }

  // ---- undecoded critical extensions ------------------------------------
  if (cert.extensions.unrecognizedCritical.length > 0) {
    checks.push(
      result(
        'cert.criticalExtensions',
        'Critical extensions',
        'warn',
        `Not decoded: ${cert.extensions.unrecognizedCritical.join(', ')}`,
        'The certificate marks these extensions critical, meaning a verifier must understand them ' +
          'or reject the certificate. pdf-seal does not decode them, so it cannot tell you what ' +
          'they require.',
      ),
    );
  }

  return checks;
}

/* ---------------------------------------------------------------------------
   Per-link checks
   ------------------------------------------------------------------------ */

export function checkLink(
  subject: ParsedCertificate,
  issuer: ParsedCertificate,
  depth: number,
): ValidationResult[] {
  const checks: ValidationResult[] = [];
  const issuerName = certificateDisplayName(issuer);
  const subjectName = certificateDisplayName(subject);

  // ---- names line up ----------------------------------------------------
  const nameMatch = subject.issuer.formatted === issuer.subject.formatted;
  checks.push(
    result(
      'link.dn',
      'Issuer name',
      nameMatch ? 'pass' : 'fail',
      nameMatch ? `Issued by ${issuerName}` : 'Issuer name does not match',
      nameMatch
        ? `${subjectName} names ${issuerName} as its issuer, and that matches the subject name of ` +
            'the certificate above it.'
        : `${subjectName} names “${subject.issuer.formatted}” as its issuer, which is not the ` +
            `subject name of ${issuerName}.`,
    ),
  );

  // ---- key identifiers line up -----------------------------------------
  const aki = subject.extensions.authorityKeyIdentifier?.keyIdentifier;
  const ski = issuer.extensions.subjectKeyIdentifier;
  if (aki && ski) {
    const match = aki === ski;
    checks.push(
      result(
        'link.akiSki',
        'Key identifier',
        match ? 'pass' : 'fail',
        match ? 'Authority key identifier matches' : 'Authority key identifier does not match',
        match
          ? 'The Authority Key Identifier on this certificate matches the Subject Key Identifier of ' +
              'its issuer, which is how a verifier locates the right issuer key.'
          : 'This certificate points at an issuer key identifier that does not match the issuer ' +
              'above it. Two different keys may share one issuer name.',
      ),
    );
  } else {
    checks.push(
      result(
        'link.akiSki',
        'Key identifier',
        'unknown',
        aki ? 'Issuer has no subject key identifier' : 'No authority key identifier present',
        'Key identifiers let a verifier pick the right issuer key when several share a name. ' +
          'They are optional, and at least one side does not carry one here.',
      ),
    );
  }

  // ---- the check that actually matters ---------------------------------
  const subjectX509 = toX509(subject);
  const issuerX509 = toX509(issuer);
  if (!subjectX509 || !issuerX509) {
    checks.push(
      result(
        'link.cryptographic',
        'Issuer signature',
        'unknown',
        'One of the two certificates could not be parsed',
        'The cryptographic check needs both certificates to be readable.',
      ),
    );
  } else {
    let verified: boolean | null = null;
    let verifyError = '';
    try {
      verified = subjectX509.verify(issuerX509.publicKey);
    } catch (error: any) {
      verifyError = error?.message ?? String(error);
    }

    if (verified === null) {
      checks.push(
        result(
          'link.cryptographic',
          'Issuer signature',
          'unknown',
          `Could not be checked: ${verifyError}`,
          'The signature on this certificate could not be verified, usually because the algorithm ' +
            'is not one this platform supports. That is not the same as the signature being wrong.',
        ),
      );
    } else {
      checks.push(
        result(
          'link.cryptographic',
          'Issuer signature',
          verified ? 'pass' : 'fail',
          verified
            ? `Cryptographically signed by ${issuerName}`
            : `Not signed by ${issuerName}`,
          verified
            ? `${issuerName}’s public key verifies the signature on ${subjectName}. This is a real ` +
                'cryptographic check, not a name comparison — but it says nothing about whether ' +
                `${issuerName} is trustworthy.`
            : `${subjectName} claims to be issued by ${issuerName}, but ${issuerName}’s public key ` +
                'does not verify its signature. The names agree and the cryptography does not.',
        ),
      );
    }
  }

  // ---- the issuer was allowed to do this --------------------------------
  const bc = issuer.extensions.basicConstraints;
  if (bc && typeof bc.pathLenConstraint === 'number') {
    // pathLen counts the non-self-issued CAs permitted below this one; depth 0
    // is the issuer of the leaf, which needs no intermediate below it.
    const below = depth;
    const withinLimit = below <= bc.pathLenConstraint;
    checks.push(
      result(
        'link.pathLen',
        'Path length',
        withinLimit ? 'pass' : 'fail',
        withinLimit
          ? `Within the limit of ${bc.pathLenConstraint}`
          : `${below} CA certificate(s) below a limit of ${bc.pathLenConstraint}`,
        withinLimit
          ? `${issuerName} permits at most ${bc.pathLenConstraint} CA certificate(s) beneath it, and ` +
              `there ${below === 1 ? 'is' : 'are'} ${below}.`
          : `${issuerName} permits at most ${bc.pathLenConstraint} CA certificate(s) beneath it, but ` +
              `the chain places ${below} there.`,
      ),
    );
  }

  return checks;
}

/* ---------------------------------------------------------------------------
   Chain building
   ------------------------------------------------------------------------ */

/**
 * Find the certificate that issued `cert`, preferring a real cryptographic
 * match over a name match. Two certificates can share a subject name (a CA that
 * rolled its key), so when the names alone are ambiguous the signature decides.
 */
function findIssuer(
  cert: ParsedCertificate,
  candidates: ParsedCertificate[],
): ParsedCertificate | null {
  const byName = candidates.filter(
    (c) => c.id !== cert.id && c.subject.formatted === cert.issuer.formatted,
  );
  if (byName.length === 0) return null;
  if (byName.length === 1) return byName[0];

  const subjectX509 = toX509(cert);
  if (subjectX509) {
    for (const candidate of byName) {
      const issuerX509 = toX509(candidate);
      if (!issuerX509) continue;
      try {
        if (subjectX509.verify(issuerX509.publicKey)) return candidate;
      } catch {
        // Try the next candidate rather than giving up on the whole chain.
      }
    }
  }

  // Fall back to an AKI/SKI match, then simply to the first by name so the
  // chain still renders and the link checks can report what is wrong.
  const aki = cert.extensions.authorityKeyIdentifier?.keyIdentifier;
  if (aki) {
    const byKeyId = byName.find((c) => c.extensions.subjectKeyIdentifier === aki);
    if (byKeyId) return byKeyId;
  }
  return byName[0];
}

/**
 * Walk from a leaf up through whatever issuers are present in the file.
 *
 * The walk stops at a self-issued certificate (the root), when no issuer is
 * present, or when a certificate is reached twice -- a cross-certified pair can
 * otherwise loop forever.
 */
export function buildChain(
  leaf: ParsedCertificate,
  pool: ParsedCertificate[],
  options: { id: string; signatureFieldName?: string | null; context?: CertificateChainContext } ,
): CertificateChain {
  const { id, signatureFieldName = null, context = {} } = options;

  const ordered: ParsedCertificate[] = [leaf];
  const seen = new Set([leaf.id]);
  let missingIssuerDn: string | null = null;

  let current = leaf;
  while (!current.selfIssued) {
    const issuer = findIssuer(current, pool);
    if (!issuer || seen.has(issuer.id)) {
      if (!issuer) missingIssuerDn = current.issuer.formatted || null;
      break;
    }
    ordered.push(issuer);
    seen.add(issuer.id);
    current = issuer;
  }

  // Roles come from position, and drive the per-certificate checks.
  ordered.forEach((cert, index) => {
    if (index === 0) cert.role = ordered.length === 1 && cert.selfIssued ? 'root' : 'signer';
    else if (cert.selfIssued) cert.role = 'root';
    else cert.role = 'intermediate';
  });

  for (const cert of ordered) {
    cert.checks = checkCertificate(cert, context);
  }

  const links: ChainLink[] = [];
  for (let i = 0; i < ordered.length - 1; i++) {
    links.push({
      subjectId: ordered[i].id,
      issuerId: ordered[i + 1].id,
      checks: checkLink(ordered[i], ordered[i + 1], i),
    });
  }

  const top = ordered[ordered.length - 1];
  const complete = top.selfIssued && top.selfSigned;
  const brokenAtIndex = complete ? null : ordered.length - 1;

  const chain: CertificateChain = {
    id,
    signatureFieldName,
    certificateIds: ordered.map((c) => c.id),
    links,
    complete,
    brokenAtIndex,
    missingIssuerDn,
    checks: [],
  };

  chain.checks = checkChain(chain, ordered, context);
  return chain;
}

function checkChain(
  chain: CertificateChain,
  ordered: ParsedCertificate[],
  context: CertificateChainContext,
): ValidationResult[] {
  const checks: ValidationResult[] = [];
  const top = ordered[ordered.length - 1];

  // ---- issuer relationships across the whole chain ----------------------
  if (chain.links.length === 0) {
    checks.push(
      result(
        'chain.issuerRelationship',
        'Issuer relationship',
        ordered[0].selfIssued ? 'pass' : 'unknown',
        ordered[0].selfIssued ? 'Single self-signed certificate' : 'No issuer certificate to check against',
        ordered[0].selfIssued
          ? 'There is one certificate and it issued itself, so there is no issuer relationship to check.'
          : 'Only one certificate is present, and it is not self-issued, so there is nothing here to ' +
              'check its signature against.',
      ),
    );
  } else {
    const linkStatuses = chain.links.map((link) => rollUp(link.checks));
    const status = worstStatus(linkStatuses);
    checks.push(
      result(
        'chain.issuerRelationship',
        'Issuer relationship',
        status,
        status === 'pass'
          ? `All ${chain.links.length} link${chain.links.length === 1 ? '' : 's'} verified`
          : `Problems in ${linkStatuses.filter((s) => s !== 'pass').length} of ${chain.links.length} link(s)`,
        'Every step of the chain was checked by name, by key identifier and by verifying the ' +
          'issuer’s signature with the issuer’s public key.',
      ),
    );
  }

  // ---- does the chain reach a root -------------------------------------
  if (chain.missingIssuerDn) {
    checks.push(
      result(
        'chain.missingIntermediate',
        'Intermediate certificate',
        'warn',
        `Missing: ${chain.missingIssuerDn}`,
        `The chain stops at ${certificateDisplayName(top)}, which says it was issued by ` +
          `“${chain.missingIssuerDn}”. That certificate is not embedded in this PDF, so the chain ` +
          'cannot be followed any further from the file alone.',
      ),
    );
  } else {
    checks.push(
      result(
        'chain.missingIntermediate',
        'Intermediate certificate',
        'pass',
        'No intermediates missing',
        'Every issuer the chain refers to is present in the file.',
      ),
    );
  }

  // ---- root ------------------------------------------------------------
  // A PDF that omits the root is normal and correct: the root belongs in the
  // verifier's trust store, not in the document. So this warns, never fails.
  if (chain.complete) {
    checks.push(
      result(
        'chain.root',
        'Root certificate',
        'pass',
        `Chain ends at ${certificateDisplayName(top)}`,
        'The chain ends at a self-signed root certificate that is embedded in this file and ' +
          'verifies against its own key. Whether that root is trusted is a separate question this ' +
          'tool cannot answer.',
      ),
    );
  } else if (top.selfIssued && !top.selfSigned) {
    checks.push(
      result(
        'chain.root',
        'Root certificate',
        'fail',
        'The root does not verify against its own key',
        'The certificate at the top of the chain names itself as its issuer but does not verify ' +
          'against its own public key, so it is not a valid root.',
      ),
    );
  } else {
    checks.push(
      result(
        'chain.root',
        'Root certificate',
        'warn',
        'Chain does not reach a root in this file',
        'The chain stops before a self-signed root. This is common and often correct — the root ' +
          'normally lives in the verifier’s trust store rather than in the document — but it means ' +
          'the chain cannot be completed from this file alone.',
      ),
    );
  }

  // ---- validity of every certificate in the chain, now ------------------
  const validityStatuses = ordered.map(
    (c) => c.checks.find((x) => x.id === 'cert.validity.window')?.status ?? 'unknown',
  );
  const validityNow = worstStatus(validityStatuses);
  const expiredNames = ordered.filter((c) => c.isExpired).map(certificateDisplayName);
  checks.push(
    result(
      'chain.validityNow',
      'Chain validity today',
      validityNow,
      expiredNames.length > 0
        ? `Expired: ${expiredNames.join(', ')}`
        : validityNow === 'pass'
          ? 'Every certificate in the chain is valid today'
          : 'One or more certificates are outside their validity period',
      'Each certificate’s validity period was compared against the current date.',
    ),
  );

  // ---- and at the claimed signing time ----------------------------------
  if (context.signingTime) {
    const atSigning = worstStatus(
      ordered.map(
        (c) => c.checks.find((x) => x.id === 'cert.validity.atSigningTime')?.status ?? 'unknown',
      ),
    );
    checks.push(
      result(
        'chain.validityAtSigningTime',
        'Chain validity when signed',
        atSigning,
        atSigning === 'pass'
          ? `Every certificate was valid on ${formatDate(context.signingTime)}`
          : 'One or more certificates were outside their validity period at that time',
        'Reported separately from validity today, because a certificate that has since expired but ' +
          'was valid when the document was signed is the normal state of an older signed PDF. The ' +
          'signing time is claimed by the signer and is not proven.',
      ),
    );
  }

  // ---- the two things we will not claim ---------------------------------
  checks.push(
    result(
      'chain.trust',
      'Trust',
      'unknown',
      'Not evaluated — no trust store',
      NO_TRUST_STORE_NOTE,
    ),
  );
  checks.push(
    result(
      'chain.revocation',
      'Revocation',
      'unknown',
      'Not checked',
      'Revocation was not checked. Any CRL and OCSP endpoints listed on these certificates are ' +
        'shown for reference only; pdf-seal makes no network requests.',
    ),
  );

  return checks;
}

/**
 * Build one chain per signer certificate, plus the certificates left over.
 *
 * Chains are kept separate rather than merged into a single tree: a certificate
 * can legitimately belong to two chains (cross-certification), and merging turns
 * a list render into a graph-layout problem for no gain.
 */
export function buildChains(
  certificates: ParsedCertificate[],
  signers: Array<{ certificateId: string; signatureFieldName: string | null; signingTime?: string | null }>,
): { chains: CertificateChain[]; unchainedIds: string[] } {
  const chains: CertificateChain[] = [];
  const used = new Set<string>();

  signers.forEach((signer, index) => {
    const leaf = certificates.find((c) => c.id === signer.certificateId);
    if (!leaf) return;
    const chain = buildChain(leaf, certificates, {
      id: `chain-${index + 1}`,
      signatureFieldName: signer.signatureFieldName,
      context: { signingTime: signer.signingTime ?? null },
    });
    chain.certificateIds.forEach((id) => used.add(id));
    chains.push(chain);
  });

  // Anything not reachable from a signer still needs its own checks run, or it
  // would render in the list with an empty validation panel.
  const unchained = certificates.filter((c) => !used.has(c.id));
  for (const cert of unchained) {
    if (cert.role === 'unknown') {
      cert.role = cert.selfIssued ? 'root' : cert.extensions.basicConstraints?.isCa ? 'intermediate' : 'unknown';
    }
    cert.checks = checkCertificate(cert, {});
  }

  return { chains, unchainedIds: unchained.map((c) => c.id) };
}

export default {
  TRUST_NOTE,
  checkCertificate,
  checkLink,
  buildChain,
  buildChains,
  rollUp,
  worstStatus,
};
