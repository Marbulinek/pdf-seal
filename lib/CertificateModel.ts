// Turns raw X.509 certificate bytes into the plain-JSON shape the Certificates
// panel renders. Deliberately knows nothing about PDFs: PdfCertificateExtractor
// finds the DER, this file explains it, and CertificateChain judges it.
//
// Two parsers are used together on purpose. Node's built-in
// crypto.X509Certificate is authoritative for fingerprints, PEM, public-key
// details and the cryptographic verify()/checkIssued() calls -- it is the
// battle-tested path and needs no dependency. pkijs fills in what Node does not
// expose at all: the KeyUsage bits, SubjectKeyIdentifier, AuthorityKeyIdentifier,
// CRL distribution points, certificate policies and the BasicConstraints
// pathLen. Neither one alone covers what the panel has to show.
//
// Nothing here invents a value. An extension that is absent from the
// certificate is reported as null and rendered as absent -- never as a default.

import * as pkijs from 'pkijs';
import * as asn1js from 'asn1js';
import { webcrypto, X509Certificate, createHash } from 'node:crypto';

/* ---------------------------------------------------------------------------
   Types
   ------------------------------------------------------------------------ */

export type ValidationStatus = 'pass' | 'warn' | 'fail' | 'unknown';

export interface ValidationResult {
  /** Stable machine id, e.g. 'link.cryptographic'. Never shown to the user. */
  id: string;
  /** Short UI label, e.g. 'Issuer signature'. */
  label: string;
  status: ValidationStatus;
  /** The result itself, e.g. 'Verified against CN=Example Issuing CA'. */
  detail: string;
  /** What was actually computed, in plain language. */
  explanation: string;
}

export interface DistinguishedNamePart {
  type: string;
  shortName: string;
  value: string;
}

export interface DistinguishedName {
  /** Most-specific-first, e.g. 'CN=Jane Doe, O=Acme, C=CZ'. */
  formatted: string;
  parts: DistinguishedNamePart[];
  commonName: string | null;
  organization: string | null;
  organizationalUnit: string | null;
  country: string | null;
  email: string | null;
}

export interface BasicConstraintsInfo {
  critical: boolean;
  isCa: boolean;
  pathLenConstraint: number | null;
}

export interface KeyUsageInfo {
  critical: boolean;
  usages: string[];
  bits: number;
}

export interface ExtendedKeyUsageInfo {
  critical: boolean;
  oids: string[];
  names: string[];
}

export interface AuthorityKeyIdentifierInfo {
  keyIdentifier: string | null;
  issuerDn: string | null;
  serial: string | null;
}

export interface GeneralNameInfo {
  type: string;
  value: string;
}

export interface CertificatePolicyInfo {
  oid: string;
  name: string | null;
  cps: string | null;
}

export interface CertificateExtensions {
  basicConstraints: BasicConstraintsInfo | null;
  keyUsage: KeyUsageInfo | null;
  extendedKeyUsage: ExtendedKeyUsageInfo | null;
  subjectKeyIdentifier: string | null;
  authorityKeyIdentifier: AuthorityKeyIdentifierInfo | null;
  subjectAltNames: GeneralNameInfo[];
  crlDistributionPoints: string[];
  authorityInfoAccess: { ocsp: string[]; caIssuers: string[] };
  certificatePolicies: CertificatePolicyInfo[];
  /** Critical extension OIDs we did not decode -- surfaced, never ignored. */
  unrecognizedCritical: string[];
}

export type CertificateRole = 'signer' | 'intermediate' | 'root' | 'unknown';

export type CertificateSourceKind = 'cms' | 'dss-certs' | 'sig-cert' | 'vri';

export interface CertificateSource {
  kind: CertificateSourceKind;
  signatureFieldName: string | null;
  objectRef: string | null;
}

export interface ParsedCertificate {
  /** SHA-256 fingerprint, lowercase hex, no colons. The join key everywhere. */
  id: string;
  /** When set, every other field is best-effort and all checks are 'unknown'. */
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
  publicKey: {
    algorithm: string;
    keySize: number | null;
    namedCurve: string | null;
    exponent: string | null;
  };
  signatureAlgorithm: { oid: string; name: string; hash: string | null };
  fingerprints: { sha256: string };
  extensions: CertificateExtensions;
  /** Subject DER equals issuer DER. */
  selfIssued: boolean;
  /** selfIssued AND the certificate verifies against its own public key. */
  selfSigned: boolean;
  role: CertificateRole;
  sources: CertificateSource[];
  pem: string;
  derBase64: string;
  derLength: number;
  checks: ValidationResult[];
}

/* ---------------------------------------------------------------------------
   Crypto engine
   ------------------------------------------------------------------------ */

let engineReady = false;

/**
 * pkijs 3 discovers WebCrypto from globalThis. Node has it, but the discovery
 * is environment-sensitive enough that Certificate.sign() and
 * SignedData.verify() can throw "Unable to create WebCrypto object" under CJS.
 * Setting the engine explicitly removes a whole class of works-here-not-there
 * failure between dev, Docker and Railway. Idempotent, called at module load.
 */
export function ensureCryptoEngine(): void {
  if (engineReady) return;
  // The cast works around a typing bug in pkijs 3.4.0: its own CryptoEngine
  // does not satisfy the ICryptoEngine interface setEngine() asks for (the
  // KEM methods are declared but not implemented). Runtime is unaffected.
  pkijs.setEngine(
    'pdfseal',
    new pkijs.CryptoEngine({ name: 'pdfseal', crypto: webcrypto as any }) as unknown as pkijs.ICryptoEngine,
  );
  engineReady = true;
}

ensureCryptoEngine();

/* ---------------------------------------------------------------------------
   OID tables -- only names we can state with confidence
   ------------------------------------------------------------------------ */

const DN_SHORT_NAMES: Record<string, string> = {
  '2.5.4.3': 'CN',
  '2.5.4.4': 'SN',
  '2.5.4.5': 'serialNumber',
  '2.5.4.6': 'C',
  '2.5.4.7': 'L',
  '2.5.4.8': 'ST',
  '2.5.4.9': 'STREET',
  '2.5.4.10': 'O',
  '2.5.4.11': 'OU',
  '2.5.4.12': 'title',
  '2.5.4.15': 'businessCategory',
  '2.5.4.17': 'postalCode',
  '2.5.4.42': 'GN',
  '2.5.4.97': 'organizationIdentifier',
  '1.2.840.113549.1.9.1': 'E',
  '0.9.2342.19200300.100.1.25': 'DC',
};

/** RFC 5280 4.2.1.3, in bit order. */
const KEY_USAGE_NAMES = [
  'digitalSignature',
  'contentCommitment',
  'keyEncipherment',
  'dataEncipherment',
  'keyAgreement',
  'keyCertSign',
  'cRLSign',
  'encipherOnly',
  'decipherOnly',
];

const EKU_NAMES: Record<string, string> = {
  '2.5.29.37.0': 'anyExtendedKeyUsage',
  '1.3.6.1.5.5.7.3.1': 'serverAuth',
  '1.3.6.1.5.5.7.3.2': 'clientAuth',
  '1.3.6.1.5.5.7.3.3': 'codeSigning',
  '1.3.6.1.5.5.7.3.4': 'emailProtection',
  '1.3.6.1.5.5.7.3.8': 'timeStamping',
  '1.3.6.1.5.5.7.3.9': 'OCSPSigning',
  '1.3.6.1.5.5.7.3.36': 'documentSigning',
  '1.2.840.113583.1.1.5': 'adobeAuthenticDocument',
};

const SIGNATURE_HASHES: Record<string, string> = {
  '1.2.840.113549.1.1.4': 'MD5',
  '1.2.840.113549.1.1.5': 'SHA-1',
  '1.2.840.113549.1.1.11': 'SHA-256',
  '1.2.840.113549.1.1.12': 'SHA-384',
  '1.2.840.113549.1.1.13': 'SHA-512',
  '1.2.840.10045.4.1': 'SHA-1',
  '1.2.840.10045.4.3.2': 'SHA-256',
  '1.2.840.10045.4.3.3': 'SHA-384',
  '1.2.840.10045.4.3.4': 'SHA-512',
  '1.3.101.112': 'SHA-512',
};

const SIGNATURE_NAMES: Record<string, string> = {
  '1.2.840.113549.1.1.4': 'RSA with MD5',
  '1.2.840.113549.1.1.5': 'RSA with SHA-1',
  '1.2.840.113549.1.1.10': 'RSA-PSS',
  '1.2.840.113549.1.1.11': 'RSA with SHA-256',
  '1.2.840.113549.1.1.12': 'RSA with SHA-384',
  '1.2.840.113549.1.1.13': 'RSA with SHA-512',
  '1.2.840.10045.4.1': 'ECDSA with SHA-1',
  '1.2.840.10045.4.3.2': 'ECDSA with SHA-256',
  '1.2.840.10045.4.3.3': 'ECDSA with SHA-384',
  '1.2.840.10045.4.3.4': 'ECDSA with SHA-512',
  '1.3.101.112': 'Ed25519',
};

/** GeneralName CHOICE tags, RFC 5280 4.2.1.6. */
const GENERAL_NAME_TYPES: Record<number, string> = {
  0: 'otherName',
  1: 'rfc822Name',
  2: 'dNSName',
  3: 'x400Address',
  4: 'directoryName',
  5: 'ediPartyName',
  6: 'uniformResourceIdentifier',
  7: 'iPAddress',
  8: 'registeredID',
};

/** Extensions this file decodes; anything else that is critical gets reported. */
const DECODED_EXTENSION_OIDS = new Set([
  '2.5.29.19',
  '2.5.29.15',
  '2.5.29.37',
  '2.5.29.14',
  '2.5.29.35',
  '2.5.29.17',
  '2.5.29.31',
  '2.5.29.32',
  '1.3.6.1.5.5.7.1.1',
]);

const OCSP_METHOD = '1.3.6.1.5.5.7.48.1';
const CA_ISSUERS_METHOD = '1.3.6.1.5.5.7.48.2';
const CPS_QUALIFIER = '1.3.6.1.5.5.7.2.1';

/* ---------------------------------------------------------------------------
   Small helpers
   ------------------------------------------------------------------------ */

function toHex(buffer: ArrayBuffer | Uint8Array | null | undefined): string {
  if (!buffer) return '';
  const view = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  return Buffer.from(view).toString('hex').toUpperCase();
}

function emptyDistinguishedName(): DistinguishedName {
  return {
    formatted: '',
    parts: [],
    commonName: null,
    organization: null,
    organizationalUnit: null,
    country: null,
    email: null,
  };
}

function emptyExtensions(): CertificateExtensions {
  return {
    basicConstraints: null,
    keyUsage: null,
    extendedKeyUsage: null,
    subjectKeyIdentifier: null,
    authorityKeyIdentifier: null,
    subjectAltNames: [],
    crlDistributionPoints: [],
    authorityInfoAccess: { ocsp: [], caIssuers: [] },
    certificatePolicies: [],
    unrecognizedCritical: [],
  };
}

/**
 * Read the printable text out of an asn1js string block. DirectoryString is a
 * CHOICE of five string types, so this has to go by value rather than by class.
 */
function asn1StringValue(value: any): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  const block = value.valueBlock;
  if (block && typeof block.value === 'string') return block.value;
  if (block && block.valueHexView) return Buffer.from(block.valueHexView).toString('utf8');
  return '';
}

/**
 * Format a DN the way certificate viewers do: most specific first. DER stores
 * the RDNs least-specific-first (C, then O, then CN), so display order is the
 * reverse of encoding order.
 */
function readDistinguishedName(name: any): DistinguishedName {
  const out = emptyDistinguishedName();
  const typesAndValues = name?.typesAndValues;
  if (!Array.isArray(typesAndValues)) return out;

  for (const tv of typesAndValues) {
    const type = String(tv.type ?? '');
    const shortName = DN_SHORT_NAMES[type] ?? type;
    const value = asn1StringValue(tv.value);
    out.parts.push({ type, shortName, value });

    // First occurrence wins -- a DN may legally repeat an attribute.
    if (type === '2.5.4.3' && out.commonName === null) out.commonName = value;
    else if (type === '2.5.4.10' && out.organization === null) out.organization = value;
    else if (type === '2.5.4.11' && out.organizationalUnit === null) out.organizationalUnit = value;
    else if (type === '2.5.4.6' && out.country === null) out.country = value;
    else if (type === '1.2.840.113549.1.9.1' && out.email === null) out.email = value;
  }

  out.formatted = out.parts
    .slice()
    .reverse()
    .map((p) => `${p.shortName}=${p.value}`)
    .join(', ');

  return out;
}

/** Best available human label for a certificate: CN, else O, else the whole DN. */
export function certificateDisplayName(cert: ParsedCertificate): string {
  return (
    cert.subject.commonName ||
    cert.subject.organization ||
    cert.subject.formatted ||
    'Unnamed certificate'
  );
}

/**
 * Decode a KeyUsage BIT STRING. Bit 0 is the most significant bit of the first
 * byte (RFC 5280), which is the opposite of the usual little-endian instinct.
 */
function readKeyUsageBits(bitString: any): { usages: string[]; bits: number } {
  const hex = bitString?.valueBlock?.valueHexView;
  if (!hex || hex.length === 0) return { usages: [], bits: 0 };

  const usages: string[] = [];
  let bits = 0;
  for (let i = 0; i < KEY_USAGE_NAMES.length; i++) {
    const byte = hex[Math.floor(i / 8)];
    if (byte === undefined) break;
    const isSet = (byte & (0x80 >> i % 8)) !== 0;
    if (isSet) {
      usages.push(KEY_USAGE_NAMES[i]);
      bits |= 1 << i;
    }
  }
  return { usages, bits };
}

function readGeneralName(name: any): GeneralNameInfo | null {
  if (!name) return null;
  const type = GENERAL_NAME_TYPES[name.type as number] ?? String(name.type ?? 'unknown');

  if (name.type === 4) {
    // directoryName carries a full DN rather than a string.
    return { type, value: readDistinguishedName(name.value).formatted };
  }
  if (name.type === 7) {
    const bytes = name.value?.valueBlock?.valueHexView;
    if (bytes && bytes.length === 4) return { type, value: Array.from(bytes as Uint8Array).join('.') };
    if (bytes) return { type, value: toHex(bytes) };
  }
  const value = asn1StringValue(name.value);
  if (!value) return null;
  return { type, value };
}

function readExtensions(extensions: any[] | undefined | null): CertificateExtensions {
  const out = emptyExtensions();
  if (!Array.isArray(extensions)) return out;

  for (const ext of extensions) {
    const oid = String(ext.extnID ?? '');
    const critical = ext.critical === true;
    const parsed = ext.parsedValue;

    if (critical && !DECODED_EXTENSION_OIDS.has(oid)) out.unrecognizedCritical.push(oid);

    try {
      switch (oid) {
        case '2.5.29.19': {
          if (!parsed) break;
          const pathLen = parsed.pathLenConstraint;
          out.basicConstraints = {
            critical,
            isCa: parsed.cA === true,
            // pathLenConstraint is an asn1js Integer when present, absent otherwise.
            pathLenConstraint:
              typeof pathLen === 'number'
                ? pathLen
                : typeof pathLen?.valueBlock?.valueDec === 'number'
                  ? pathLen.valueBlock.valueDec
                  : null,
          };
          break;
        }
        case '2.5.29.15': {
          // pkijs leaves this as a raw BitString; the bit meanings are ours to apply.
          const bitString = parsed ?? asn1js.fromBER(ext.extnValue.valueBlock.valueHexView).result;
          const { usages, bits } = readKeyUsageBits(bitString);
          out.keyUsage = { critical, usages, bits };
          break;
        }
        case '2.5.29.37': {
          const oids: string[] = (parsed?.keyPurposes ?? []).map((p: any) => String(p));
          out.extendedKeyUsage = {
            critical,
            oids,
            names: oids.map((o) => EKU_NAMES[o] ?? o),
          };
          break;
        }
        case '2.5.29.14': {
          out.subjectKeyIdentifier = toHex(parsed?.valueBlock?.valueHexView) || null;
          break;
        }
        case '2.5.29.35': {
          if (!parsed) break;
          const issuerName = parsed.authorityCertIssuer?.[0];
          out.authorityKeyIdentifier = {
            keyIdentifier: toHex(parsed.keyIdentifier?.valueBlock?.valueHexView) || null,
            issuerDn: issuerName ? (readGeneralName(issuerName)?.value ?? null) : null,
            serial: toHex(parsed.authorityCertSerialNumber?.valueBlock?.valueHexView) || null,
          };
          break;
        }
        case '2.5.29.17': {
          for (const n of parsed?.altNames ?? []) {
            const info = readGeneralName(n);
            if (info) out.subjectAltNames.push(info);
          }
          break;
        }
        case '2.5.29.31': {
          for (const point of parsed?.distributionPoints ?? []) {
            for (const n of point.distributionPoint ?? []) {
              const info = readGeneralName(n);
              if (info?.value) out.crlDistributionPoints.push(info.value);
            }
          }
          break;
        }
        case '1.3.6.1.5.5.7.1.1': {
          for (const access of parsed?.accessDescriptions ?? []) {
            const location = readGeneralName(access.accessLocation)?.value;
            if (!location) continue;
            if (access.accessMethod === OCSP_METHOD) out.authorityInfoAccess.ocsp.push(location);
            else if (access.accessMethod === CA_ISSUERS_METHOD) {
              out.authorityInfoAccess.caIssuers.push(location);
            }
          }
          break;
        }
        case '2.5.29.32': {
          for (const policy of parsed?.certificatePolicies ?? []) {
            let cps: string | null = null;
            for (const qualifier of policy.policyQualifiers ?? []) {
              if (qualifier.policyQualifierId === CPS_QUALIFIER) {
                cps = asn1StringValue(qualifier.qualifier) || null;
              }
            }
            out.certificatePolicies.push({
              oid: String(policy.policyIdentifier ?? ''),
              name: null,
              cps,
            });
          }
          break;
        }
        default:
          break;
      }
    } catch {
      // A malformed extension must not sink the whole certificate. It is simply
      // reported as absent, and stays listed in unrecognizedCritical if critical.
    }
  }

  return out;
}

function readPublicKey(x509: X509Certificate): ParsedCertificate['publicKey'] {
  try {
    const key = x509.publicKey;
    const details: any = key.asymmetricKeyDetails ?? {};
    const exponent = details.publicExponent;
    return {
      algorithm: key.asymmetricKeyType ?? 'unknown',
      keySize: typeof details.modulusLength === 'number' ? details.modulusLength : null,
      namedCurve: details.namedCurve ?? null,
      exponent: exponent === undefined || exponent === null ? null : String(exponent),
    };
  } catch {
    return { algorithm: 'unknown', keySize: null, namedCurve: null, exponent: null };
  }
}

/**
 * DER of the TBS subject/issuer fields, for byte-exact name comparison. Comparing
 * formatted strings would let encoding and whitespace differences pass as a match.
 */
export function encodedName(name: any): Buffer | null {
  try {
    return Buffer.from(name.toSchema().toBER(false));
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------------------
   Public API
   ------------------------------------------------------------------------ */
export function certificateFingerprints(der: Uint8Array): { sha256: string } {
  const buf = Buffer.from(der);
  return {
    sha256: createHash('sha256').update(buf).digest('hex'),
  };
}

export function derToPem(der: Uint8Array): string {
  const body = Buffer.from(der).toString('base64').replace(/(.{64})/g, '$1\n').trimEnd();
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`;
}

/**
 * Parse one DER-encoded certificate. Never throws: a certificate we cannot read
 * still has to appear in the list with an explanation, because "there is
 * something here we could not parse" is itself a finding worth showing.
 */
export function parseCertificate(der: Uint8Array): ParsedCertificate {
  ensureCryptoEngine();

  const fingerprints = certificateFingerprints(der);
  const base: ParsedCertificate = {
    id: fingerprints.sha256,
    parseError: null,
    version: 0,
    serialNumber: '',
    subject: emptyDistinguishedName(),
    issuer: emptyDistinguishedName(),
    validFrom: '',
    validTo: '',
    isExpired: false,
    isNotYetValid: false,
    daysUntilExpiry: null,
    publicKey: { algorithm: 'unknown', keySize: null, namedCurve: null, exponent: null },
    signatureAlgorithm: { oid: '', name: '', hash: null },
    fingerprints,
    extensions: emptyExtensions(),
    selfIssued: false,
    selfSigned: false,
    role: 'unknown',
    sources: [],
    pem: derToPem(der),
    derBase64: Buffer.from(der).toString('base64'),
    derLength: der.length,
    checks: [],
  };

  let pkiCert: pkijs.Certificate;
  let x509: X509Certificate;
  try {
    pkiCert = pkijs.Certificate.fromBER(der);
    x509 = new X509Certificate(Buffer.from(der));
  } catch (error: any) {
    base.parseError = error?.message
      ? `This is not a certificate we can read: ${error.message}`
      : 'This is not a certificate we can read.';
    return base;
  }

  base.version = (pkiCert.version ?? 0) + 1; // ASN.1 stores v3 as the integer 2.
  base.serialNumber = toHex(pkiCert.serialNumber?.valueBlock?.valueHexView) || x509.serialNumber;
  base.subject = readDistinguishedName(pkiCert.subject);
  base.issuer = readDistinguishedName(pkiCert.issuer);

  const notBefore = pkiCert.notBefore?.value ?? x509.validFromDate;
  const notAfter = pkiCert.notAfter?.value ?? x509.validToDate;
  base.validFrom = notBefore instanceof Date ? notBefore.toISOString() : '';
  base.validTo = notAfter instanceof Date ? notAfter.toISOString() : '';

  const now = Date.now();
  if (notAfter instanceof Date) {
    base.isExpired = notAfter.getTime() < now;
    base.daysUntilExpiry = Math.floor((notAfter.getTime() - now) / 86400000);
  }
  if (notBefore instanceof Date) base.isNotYetValid = notBefore.getTime() > now;

  base.publicKey = readPublicKey(x509);

  const sigOid = String(pkiCert.signatureAlgorithm?.algorithmId ?? x509.signatureAlgorithmOid ?? '');
  base.signatureAlgorithm = {
    oid: sigOid,
    name: SIGNATURE_NAMES[sigOid] ?? x509.signatureAlgorithm ?? sigOid,
    hash: SIGNATURE_HASHES[sigOid] ?? null,
  };

  base.extensions = readExtensions(pkiCert.extensions);

  const subjectDer = encodedName(pkiCert.subject);
  const issuerDer = encodedName(pkiCert.issuer);
  base.selfIssued = Boolean(subjectDer && issuerDer && subjectDer.equals(issuerDer));
  if (base.selfIssued) {
    try {
      base.selfSigned = x509.verify(x509.publicKey);
    } catch {
      // Unsupported algorithm: self-issued stands, self-signed stays unproven.
      base.selfSigned = false;
    }
  }

  return base;
}

const PEM_BLOCK = /-----BEGIN CERTIFICATE-----([A-Za-z0-9+/=\s]+?)-----END CERTIFICATE-----/g;

/**
 * Parse a certificate file the user picked: PEM (one or many), bare DER, or a
 * PKCS#7 bundle (.p7b) carrying a chain. Throws with a message meant to be
 * shown as-is, because every failure here is a user-supplied-file problem.
 */
export function parseCertificateFile(bytes: Uint8Array): ParsedCertificate[] {
  ensureCryptoEngine();

  if (!bytes || bytes.length === 0) throw new Error('That file is empty.');

  // PKCS#12 is password-protected and carries a private key. It must never be
  // uploaded to this server, so refuse it by signature rather than by extension.
  const text = Buffer.from(bytes.subarray(0, Math.min(bytes.length, 8192))).toString('latin1');
  if (text.includes('-----BEGIN ENCRYPTED PRIVATE KEY-----') || text.includes('-----BEGIN PRIVATE KEY-----')) {
    throw new Error(
      'That file contains a private key. Upload only the certificate (.cer, .crt, .der or .pem) — never a key or a .p12/.pfx bundle.',
    );
  }

  const certs: ParsedCertificate[] = [];

  // PEM, possibly several concatenated.
  if (text.includes('-----BEGIN CERTIFICATE-----')) {
    const full = Buffer.from(bytes).toString('latin1');
    let match: RegExpExecArray | null;
    PEM_BLOCK.lastIndex = 0;
    while ((match = PEM_BLOCK.exec(full)) !== null) {
      const der = Buffer.from(match[1].replace(/\s+/g, ''), 'base64');
      if (der.length > 0) certs.push(parseCertificate(new Uint8Array(der)));
    }
    if (certs.length === 0) throw new Error('That PEM file has no readable certificate block in it.');
    return certs;
  }

  if (bytes[0] !== 0x30) {
    throw new Error(
      'That does not look like a certificate. Supported formats are PEM, DER and PKCS#7 (.cer, .crt, .der, .pem, .p7b).',
    );
  }

  // A PKCS#7 bundle is a ContentInfo wrapping SignedData whose only useful part
  // here is the certificate set; a bare certificate is a SEQUENCE too, so try
  // the bundle first and fall through to the single-certificate reading.
  try {
    const contentInfo = pkijs.ContentInfo.fromBER(bytes);
    if (contentInfo.contentType === '1.2.840.113549.1.7.2') {
      const signedData = new pkijs.SignedData({ schema: contentInfo.content });
      for (const entry of signedData.certificates ?? []) {
        if (entry instanceof pkijs.Certificate) {
          certs.push(parseCertificate(new Uint8Array(entry.toSchema(true).toBER(false))));
        }
      }
      if (certs.length === 0) throw new Error('That PKCS#7 bundle contains no certificates.');
      return certs;
    }
  } catch (error: any) {
    if (String(error?.message ?? '').includes('PKCS#7 bundle contains no certificates')) throw error;
    // Not a bundle -- fall through and read it as a single certificate.
  }

  const single = parseCertificate(bytes);
  if (single.parseError) throw new Error(single.parseError);
  return [single];
}

export default {
  ensureCryptoEngine,
  parseCertificate,
  parseCertificateFile,
  certificateFingerprints,
  certificateDisplayName,
  derToPem,
  encodedName,
};
