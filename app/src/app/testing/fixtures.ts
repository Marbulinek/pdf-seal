// Small typed builders for the server payloads, shared by the specs.
import type {
  CertificateChain,
  CheckAxis,
  CertificateReport,
  DocField,
  ParsedCertificate,
  ReportSignature,
  ValidationResult,
  ValidationStatus,
} from '../core/models';

export function check(id: string, status: ValidationStatus, label = id, axis: CheckAxis = 'signature'): ValidationResult {
  return { id, label, status, detail: `${label} detail`, explanation: `${label} why`, axis };
}

export function makeCert(id: string, patch: Partial<ParsedCertificate> = {}): ParsedCertificate {
  const dn = (cn: string) => ({
    formatted: `CN=${cn}`,
    commonName: cn,
    organization: 'Org',
    organizationalUnit: null,
    country: 'US',
    email: null,
  });
  return {
    id,
    parseError: null,
    version: 3,
    serialNumber: '01',
    subject: dn(id),
    issuer: dn(`${id}-issuer`),
    validFrom: '2020-01-01T00:00:00Z',
    validTo: '2040-01-01T00:00:00Z',
    isExpired: false,
    isNotYetValid: false,
    daysUntilExpiry: 1000,
    publicKey: { algorithm: 'RSA', keySize: 2048, namedCurve: null, exponent: '65537' },
    signatureAlgorithm: { oid: '1.2', name: 'sha256WithRSAEncryption', hash: 'SHA-256' },
    fingerprints: { sha256: `${id}-sha` },
    extensions: {
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
    },
    selfIssued: false,
    selfSigned: false,
    role: 'signer',
    sources: [{ kind: 'cms', signatureFieldName: 'Sig1', objectRef: null }],
    pem: `-----BEGIN CERTIFICATE-----\n${id}\n-----END CERTIFICATE-----\n`,
    derBase64: btoa(id),
    derLength: id.length,
    checks: [check(`${id}.ok`, 'pass')],
    ...patch,
  };
}

export function makeSignature(patch: Partial<ReportSignature> = {}): ReportSignature {
  return {
    fieldName: 'Sig1',
    page: 0,
    name: 'Alex Morgan',
    reason: 'Approve',
    location: null,
    signingTimeClaimed: '2024-05-01T10:00:00Z',
    cmsSlot: { byteRange: [0, 100, 200, 300], capacityBytes: 1000, derLength: 400, headroomBytes: 600, coversWholeFile: true, trailingBytes: 0 },
    cmsError: null,
    signedAttributes: null,
    hasTimestampToken: false,
    isDocumentTimestamp: false,
    messageImprint: null,
    timestampTime: null,
    certificateIds: ['leaf', 'ca'],
    signerCertificateId: 'leaf',
    chainId: 'chain1',
    revisionCoverage: { coveredRevision: 1, revisionCount: 2 },
    checks: [check('sig.messageDigest', 'pass', 'Digest'), check('sig.cryptographic', 'warn', 'CMS')],
    status: 'warn',
    ...patch,
  };
}

export function makeChain(patch: Partial<CertificateChain> = {}): CertificateChain {
  return {
    id: 'chain1',
    signatureFieldName: 'Sig1',
    certificateIds: ['leaf', 'ca'],
    links: [{ subjectId: 'leaf', issuerId: 'ca', checks: [check('link', 'pass')] }],
    complete: true,
    brokenAtIndex: null,
    missingIssuerDn: null,
    checks: [check('chain.ok', 'pass')],
    ...patch,
  };
}

export function makeReport(patch: Partial<CertificateReport> = {}): CertificateReport {
  return {
    generatedAt: '2024-05-02T00:00:00Z',
    documentHasSignatures: true,
    signatureFieldCount: 1,
    unsignedSignatureFieldNames: [],
    signatures: [makeSignature()],
    certificates: [makeCert('leaf'), makeCert('ca', { role: 'root', selfIssued: true, selfSigned: true })],
    chains: [makeChain()],
    unchainedCertificateIds: [],
    trust: { hasTrustStore: false, note: 'No trust store.' },
    summary: { status: 'warn', headline: 'One warning', counts: { pass: 5, warn: 1, fail: 0, unknown: 0 } },
    warnings: [],
    truncated: false,
    ...patch,
  };
}

export function makeField(name: string, patch: Partial<DocField> = {}): DocField {
  return { name, type: 'Signature', page: 0, required: false, rect: { x: 10, y: 10, width: 200, height: 60 }, ...patch };
}
