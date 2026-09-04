// Finds every certificate a PDF carries, and works out which signature each one
// belongs to.
//
// There are four places they hide:
//
//   1. the PKCS#7/CMS blob in a signature's /Contents  -- the primary source
//   2. /DSS /Certs                                     -- PAdES long-term validation
//   3. /Sig /Cert                                      -- legacy adbe.x509.rsa_sha1
//   4. /DSS /VRI                                       -- per-signature grouping of (2)
//
// The one subtlety worth understanding is how /Contents is read. It is NOT read
// through pdf-lib, because pdf-lib hands back a decoded string and the CMS is
// binary. Instead the offsets are derived arithmetically from /ByteRange and the
// bytes are sliced straight out of the file. With /ByteRange [a b c d] the
// signed ranges are [a, a+b) and [c, c+d), so the unsigned gap between them --
// [a+b, c) -- is exactly the hex string `<...>` holding the CMS. That is the
// only way to recover those bytes exactly as written, and the same offsets are
// what PdfCertificateModifier later patches in place.

import { createHash } from 'node:crypto';
import * as pkijs from 'pkijs';
import * as asn1js from 'asn1js';
import PdfSignatureTool from './PdfSignatureTool';
import {
  ensureCryptoEngine,
  parseCertificate,
  type ParsedCertificate,
  type CertificateSourceKind,
} from './CertificateModel';

export interface CmsSlot {
  byteRange: [number, number, number, number];
  /** Offset of the '<' that opens the hex string. */
  gapStart: number;
  /** Offset one past the '>' that closes it. */
  gapEnd: number;
  hexStart: number;
  hexEnd: number;
  /** Bytes the slot can hold, i.e. half the hex characters available. */
  capacityBytes: number;
  /** Bytes the CMS actually uses, before the zero padding. */
  derLength: number;
  /** How the CMS is encoded. Filled in with derLength, once it has been read. */
  encoding: CmsEncoding;
  /** capacityBytes - derLength. What a modification has to fit into. */
  headroomBytes: number;
  /** The two signed ranges together cover the whole file. */
  coversWholeFile: boolean;
  /** Bytes after the end of the second signed range. */
  trailingBytes: number;
}

export type SignerIdentifier =
  | { type: 'issuerAndSerial'; issuerDn: string; serial: string }
  | { type: 'subjectKeyIdentifier'; ski: string };

export interface SignedAttributeSummary {
  contentType: string | null;
  messageDigest: string | null;
  signingTime: string | null;
  others: string[];
}

export interface ExtractedSignature {
  fieldName: string;
  page: number | null;
  filter: string | null;
  subFilter: string | null;
  name: string | null;
  reason: string | null;
  location: string | null;
  contactInfo: string | null;
  /** Signing time from the signature dictionary's /M. Claimed, not proven. */
  signingTimeClaimed: string | null;
  byteRange: number[] | null;
  cmsSlot: CmsSlot | null;
  cmsError: string | null;
  signerSid: SignerIdentifier | null;
  digestAlgorithm: string | null;
  signatureAlgorithm: string | null;
  signedAttributes: SignedAttributeSummary;
  hasTimestampToken: boolean;
  docMdpLevel: number | null;
  objectRef: string | null;
  /** Uppercase hex SHA-1 of the /Contents bytes -- the key /VRI uses. */
  contentsSha1: string | null;
  /** ids of every certificate this signature carries. */
  certificateIds: string[];
  signerCertificateId: string | null;
}

export interface RawCertificateSource {
  der: Uint8Array;
  kind: CertificateSourceKind;
  signatureFieldName: string | null;
  objectRef: string | null;
}

export interface ExtractionResult {
  signatures: ExtractedSignature[];
  certificates: ParsedCertificate[];
  signatureFieldCount: number;
  unsignedSignatureFieldNames: string[];
  warnings: string[];
}

const OID_CONTENT_TYPE = '1.2.840.113549.1.9.3';
const OID_MESSAGE_DIGEST = '1.2.840.113549.1.9.4';
const OID_SIGNING_TIME = '1.2.840.113549.1.9.5';
const OID_TIMESTAMP_TOKEN = '1.2.840.113549.1.9.16.2.14';
const OID_SIGNED_DATA = '1.2.840.113549.1.7.2';

const DIGEST_NAMES: Record<string, string> = {
  '1.3.14.3.2.26': 'SHA-1',
  '2.16.840.1.101.3.4.2.1': 'SHA-256',
  '2.16.840.1.101.3.4.2.2': 'SHA-384',
  '2.16.840.1.101.3.4.2.3': 'SHA-512',
  '2.16.840.1.101.3.4.2.4': 'SHA-224',
};

const SIGNATURE_ALGORITHM_NAMES: Record<string, string> = {
  '1.2.840.113549.1.1.1': 'RSA',
  '1.2.840.113549.1.1.11': 'RSA with SHA-256',
  '1.2.840.113549.1.1.10': 'RSA-PSS',
  '1.2.840.10045.2.1': 'ECDSA',
  '1.2.840.10045.4.3.2': 'ECDSA with SHA-256',
  '1.2.840.10045.4.3.3': 'ECDSA with SHA-384',
  '1.2.840.10045.4.3.4': 'ECDSA with SHA-512',
};

function toHex(value: ArrayBuffer | Uint8Array | null | undefined): string {
  if (!value) return '';
  const view = value instanceof Uint8Array ? value : new Uint8Array(value);
  return Buffer.from(view).toString('hex').toUpperCase();
}

/**
 * Work out where a signature's CMS blob sits in the file.
 *
 * Returns null when /ByteRange is not the four sensible numbers it must be, or
 * when the bytes it points at are not a `<...>` hex string -- in either case the
 * signature is malformed and there is nothing to slice.
 */
export function findCmsSlot(bytes: Uint8Array, byteRange: number[] | null): CmsSlot | null {
  if (!Array.isArray(byteRange) || byteRange.length !== 4) return null;
  const [a, b, c, d] = byteRange;
  if (![a, b, c, d].every((n) => Number.isInteger(n) && n >= 0)) return null;

  const gapStart = a + b;
  const gapEnd = c;
  if (gapEnd <= gapStart + 2) return null;
  if (gapEnd > bytes.length || c + d > bytes.length) return null;

  // 0x3C '<' and 0x3E '>' -- if these are not where the arithmetic says, the
  // /ByteRange does not describe this file and nothing below can be trusted.
  if (bytes[gapStart] !== 0x3c || bytes[gapEnd - 1] !== 0x3e) return null;

  const hexStart = gapStart + 1;
  const hexEnd = gapEnd - 1;
  const capacityBytes = Math.floor((hexEnd - hexStart) / 2);

  return {
    byteRange: [a, b, c, d],
    gapStart,
    gapEnd,
    hexStart,
    hexEnd,
    capacityBytes,
    derLength: 0, // filled in once the DER has been read
    encoding: 'definite',
    headroomBytes: 0,
    coversWholeFile: a === 0 && c + d === bytes.length,
    trailingBytes: Math.max(0, bytes.length - (c + d)),
  };
}

/**
 * Which of the two ASN.1 length encodings a signature's content uses.
 *
 * CMS is BER, not DER: a signer is free to write indefinite lengths (`30 80 ...
 * 00 00`) instead of counting the bytes up front, and streaming signers do.
 * Both forms are read here; only the definite one can be measured arithmetically.
 */
export type CmsEncoding = 'definite' | 'indefinite';

export type CmsReadFailure = 'no-hex' | 'empty-slot' | 'not-asn1' | 'truncated' | 'unreadable';

export type CmsReadResult =
  | { ok: true; cms: Uint8Array; encoding: CmsEncoding }
  | { ok: false; reason: CmsReadFailure; detail: string };

/** Where asn1js says the first value in `raw` ends, or null if it cannot say. */
function asn1EndOffset(raw: Uint8Array): number | null {
  try {
    const parsed = asn1js.fromBER(raw);
    if (parsed.offset === -1 || parsed.offset > raw.length) return null;
    if (parsed.result?.error) return null;
    return parsed.offset;
  } catch {
    return null;
  }
}

function leadingBytes(raw: Uint8Array, count = 4): string {
  return Array.from(raw.subarray(0, count))
    .map((b) => b.toString(16).padStart(2, '0').toUpperCase())
    .join(' ');
}

/**
 * Decode the hex in a slot back to the CMS it holds, saying why when it cannot.
 *
 * Signers reserve a fixed-size slot and pad the unused tail, usually with zeros,
 * so the trailing padding is trimmed by reading the ASN.1 length rather than by
 * trusting the padding to be any particular byte. The length itself comes two
 * ways: the definite form is read arithmetically from the header, and the
 * indefinite form -- which has no length to read, only a terminator somewhere
 * inside -- is measured by handing the bytes to asn1js.
 *
 * Every refusal names what was actually wrong. A signature that cannot be read
 * is the one place a user has nothing else to go on, so "could not be decoded"
 * for five different faults is not good enough.
 */
export function readCmsFromSlotDetailed(bytes: Uint8Array, slot: CmsSlot): CmsReadResult {
  const hex = Buffer.from(bytes.subarray(slot.hexStart, slot.hexEnd)).toString('latin1');
  const cleaned = hex.replace(/[^0-9a-fA-F]/g, '');
  if (cleaned.length < 4) {
    return {
      ok: false,
      reason: 'no-hex',
      detail:
        'The space reserved for this signature holds no hex digits, so there is no content to read.',
    };
  }

  const raw = Buffer.from(cleaned.slice(0, cleaned.length - (cleaned.length % 2)), 'hex');
  if (raw.length < 2) {
    return {
      ok: false,
      reason: 'no-hex',
      detail: 'The space reserved for this signature holds too few bytes to be a signature.',
    };
  }

  if (raw.every((byte) => byte === 0)) {
    return {
      ok: false,
      reason: 'empty-slot',
      detail:
        `The ${raw.length}-byte space reserved for this signature is entirely zeros. The field was ` +
        'prepared for signing but nothing was ever written into it.',
    };
  }

  if (raw[0] !== 0x30) {
    return {
      ok: false,
      reason: 'not-asn1',
      detail:
        `This signature's content starts with ${leadingBytes(raw)} rather than an ASN.1 SEQUENCE, ` +
        'so it is not the CMS structure its /SubFilter claims.',
    };
  }

  const first = raw[1];

  // BER indefinite length: no length to read, just a 00 00 terminator somewhere
  // after the nested values. asn1js walks them and reports where it ends.
  if (first === 0x80) {
    const end = asn1EndOffset(raw);
    if (end === null || end < 3) {
      return {
        ok: false,
        reason: 'unreadable',
        detail:
          'This signature is written with BER indefinite lengths and its structure could not be ' +
          'parsed, so the end of the content could not be found.',
      };
    }
    return { ok: true, cms: new Uint8Array(raw.subarray(0, end)), encoding: 'indefinite' };
  }

  let length: number;
  let headerLength: number;
  if (first < 0x80) {
    length = first;
    headerLength = 2;
  } else {
    const lengthBytes = first & 0x7f;
    if (lengthBytes > 4 || raw.length < 2 + lengthBytes) {
      return {
        ok: false,
        reason: 'unreadable',
        detail:
          `This signature's content begins ${leadingBytes(raw)}, which is not a length any real ` +
          'signature would declare, so its content could not be measured.',
      };
    }
    length = 0;
    for (let i = 0; i < lengthBytes; i++) length = length * 256 + raw[2 + i];
    headerLength = 2 + lengthBytes;
  }

  const total = headerLength + length;
  if (total > raw.length) {
    return {
      ok: false,
      reason: 'truncated',
      detail:
        `This signature declares ${total} bytes of content but only ${raw.length} are present in ` +
        'the space reserved for it, so it is truncated. The file was probably altered after signing.',
    };
  }

  return { ok: true, cms: new Uint8Array(raw.subarray(0, total)), encoding: 'definite' };
}

/** As readCmsFromSlotDetailed(), for callers that only need the bytes. */
export function readCmsFromSlot(bytes: Uint8Array, slot: CmsSlot): Uint8Array | null {
  const read = readCmsFromSlotDetailed(bytes, slot);
  return read.ok ? read.cms : null;
}

interface CmsFacts {
  certificates: Uint8Array[];
  signerSid: SignerIdentifier | null;
  digestAlgorithm: string | null;
  signatureAlgorithm: string | null;
  signedAttributes: SignedAttributeSummary;
  hasTimestampToken: boolean;
}

function emptyCmsFacts(): CmsFacts {
  return {
    certificates: [],
    signerSid: null,
    digestAlgorithm: null,
    signatureAlgorithm: null,
    signedAttributes: { contentType: null, messageDigest: null, signingTime: null, others: [] },
    hasTimestampToken: false,
  };
}

/**
 * Read the parts of a CMS SignedData this feature cares about.
 *
 * Every field is optional as far as this function is concerned: a blob we can
 * open but only partly understand still yields its certificates, which is the
 * thing the panel most needs.
 */
export function readCmsFacts(cms: Uint8Array): CmsFacts {
  ensureCryptoEngine();
  const facts = emptyCmsFacts();

  const contentInfo = pkijs.ContentInfo.fromBER(cms);
  if (contentInfo.contentType !== OID_SIGNED_DATA) {
    throw new Error(
      `The signature holds a ${contentInfo.contentType} structure rather than CMS SignedData.`,
    );
  }

  const signedData = new pkijs.SignedData({ schema: contentInfo.content });

  for (const entry of signedData.certificates ?? []) {
    if (entry instanceof pkijs.Certificate) {
      try {
        facts.certificates.push(new Uint8Array(entry.toSchema(true).toBER(false)));
      } catch {
        // A certificate we cannot re-encode is skipped; the rest still list.
      }
    }
  }

  const signer = signedData.signerInfos?.[0];
  if (!signer) return facts;

  facts.digestAlgorithm =
    DIGEST_NAMES[String(signer.digestAlgorithm?.algorithmId ?? '')] ??
    String(signer.digestAlgorithm?.algorithmId ?? '') ??
    null;
  const sigOid = String(signer.signatureAlgorithm?.algorithmId ?? '');
  facts.signatureAlgorithm = SIGNATURE_ALGORITHM_NAMES[sigOid] ?? sigOid ?? null;

  const sid: any = signer.sid;
  if (sid instanceof pkijs.IssuerAndSerialNumber) {
    const parts = (sid.issuer?.typesAndValues ?? [])
      .map((tv: any) => {
        const value = tv.value?.valueBlock?.value ?? '';
        return `${tv.type}=${value}`;
      })
      .reverse()
      .join(', ');
    facts.signerSid = {
      type: 'issuerAndSerial',
      issuerDn: parts,
      serial: toHex(sid.serialNumber?.valueBlock?.valueHexView),
    };
  } else if (sid?.valueBlock?.valueHexView) {
    facts.signerSid = { type: 'subjectKeyIdentifier', ski: toHex(sid.valueBlock.valueHexView) };
  }

  for (const attribute of signer.signedAttrs?.attributes ?? []) {
    const type = String(attribute.type ?? '');
    const value = attribute.values?.[0];
    switch (type) {
      case OID_CONTENT_TYPE:
        facts.signedAttributes.contentType = String(value?.valueBlock?.toString?.() ?? '') || null;
        break;
      case OID_MESSAGE_DIGEST:
        facts.signedAttributes.messageDigest = toHex(value?.valueBlock?.valueHexView) || null;
        break;
      case OID_SIGNING_TIME: {
        const date = value?.toDate?.();
        facts.signedAttributes.signingTime =
          date instanceof Date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
        break;
      }
      default:
        facts.signedAttributes.others.push(type);
        break;
    }
  }

  for (const attribute of signer.unsignedAttrs?.attributes ?? []) {
    if (String(attribute.type ?? '') === OID_TIMESTAMP_TOKEN) facts.hasTimestampToken = true;
  }

  return facts;
}

/** The two /ByteRange-covered spans, concatenated -- the bytes a signature signs. */
export function signedByteRangeSlice(bytes: Uint8Array, byteRange: number[]): Buffer {
  const [a, b, c, d] = byteRange;
  return Buffer.concat([
    Buffer.from(bytes.subarray(a, a + b)),
    Buffer.from(bytes.subarray(c, c + d)),
  ]);
}

/**
 * Walk a PDF and return every certificate in it, each tagged with where it came
 * from and which signature (if any) it belongs to.
 *
 * Certificates are deduplicated by SHA-256 fingerprint, so a certificate that
 * appears both inside a CMS blob and in /DSS /Certs is one entry carrying two
 * sources rather than two near-identical rows in the list.
 */
export async function extractCertificateSources(bytes: Uint8Array): Promise<ExtractionResult> {
  ensureCryptoEngine();

  const warnings: string[] = [];
  const signatures: ExtractedSignature[] = [];
  const sources: RawCertificateSource[] = [];

  let tool: any;
  try {
    tool = await PdfSignatureTool.fromBytes(bytes);
  } catch (error: any) {
    return {
      signatures: [],
      certificates: [],
      signatureFieldCount: 0,
      unsignedSignatureFieldNames: [],
      warnings: [error?.message ?? 'This PDF could not be opened.'],
    };
  }

  const allFields = tool.listFields();
  const signatureFields = allFields.filter((f: any) => f.type === 'Signature');
  const unsignedSignatureFieldNames = signatureFields
    .filter((f: any) => !f.signed)
    .map((f: any) => f.name);

  // ---- 1 & 3: the signature dictionaries -------------------------------
  for (const dict of tool.getSignatureDictionaries()) {
    const slot = findCmsSlot(bytes, dict.byteRange);
    const signature: ExtractedSignature = {
      fieldName: dict.fieldName,
      page: dict.page,
      filter: dict.filter,
      subFilter: dict.subFilter,
      name: dict.name,
      reason: dict.reason,
      location: dict.location,
      contactInfo: dict.contactInfo,
      signingTimeClaimed: dict.signingTime,
      byteRange: dict.byteRange,
      cmsSlot: slot,
      cmsError: null,
      signerSid: null,
      digestAlgorithm: null,
      signatureAlgorithm: null,
      signedAttributes: { contentType: null, messageDigest: null, signingTime: null, others: [] },
      hasTimestampToken: false,
      docMdpLevel: dict.docMdpLevel,
      objectRef: dict.objectRef,
      contentsSha1: null,
      certificateIds: [],
      signerCertificateId: null,
    };

    // 3: /Cert, used by the legacy adbe.x509.rsa_sha1 subfilter.
    for (const der of dict.certDer ?? []) {
      sources.push({
        der,
        kind: 'sig-cert',
        signatureFieldName: dict.fieldName,
        objectRef: dict.objectRef,
      });
    }

    // 1: the CMS blob.
    if (!dict.byteRange) {
      signature.cmsError = 'This signature has no /ByteRange, so its content cannot be located.';
    } else if (!slot) {
      signature.cmsError =
        'This signature’s /ByteRange does not point at a hex string in this file, so its content ' +
        'could not be read. The file may have been modified after signing.';
    } else {
      const read = readCmsFromSlotDetailed(bytes, slot);
      if (!read.ok) {
        signature.cmsError = read.detail;
      } else {
        const cms = read.cms;
        slot.encoding = read.encoding;
        slot.derLength = cms.length;
        slot.headroomBytes = slot.capacityBytes - cms.length;
        signature.contentsSha1 = createHash('sha1').update(cms).digest('hex').toUpperCase();

        try {
          const facts = readCmsFacts(cms);
          signature.signerSid = facts.signerSid;
          signature.digestAlgorithm = facts.digestAlgorithm;
          signature.signatureAlgorithm = facts.signatureAlgorithm;
          signature.signedAttributes = facts.signedAttributes;
          signature.hasTimestampToken = facts.hasTimestampToken;
          for (const der of facts.certificates) {
            sources.push({
              der,
              kind: 'cms',
              signatureFieldName: dict.fieldName,
              objectRef: dict.objectRef,
            });
          }
        } catch (error: any) {
          signature.cmsError = error?.message ?? 'The signature content could not be parsed.';
        }
      }
    }

    signatures.push(signature);
  }

  // ---- 2 & 4: the document security store ------------------------------
  let dss: { certs: any[]; vri: any[] } = { certs: [], vri: [] };
  try {
    dss = tool.getDocumentSecurityStore();
  } catch (error: any) {
    warnings.push(`The document security store could not be read: ${error?.message ?? error}`);
  }

  // 4: /VRI keys are the SHA-1 of a signature's /Contents, which is how a DSS
  // certificate gets attributed to one signature rather than to the document.
  const vriOwnerByRef = new Map<string, string>();
  for (const entry of dss.vri) {
    const owner = signatures.find((s) => s.contentsSha1 === entry.key);
    if (!owner) continue;
    for (const ref of entry.certRefs) vriOwnerByRef.set(ref, owner.fieldName);
  }

  for (const cert of dss.certs) {
    const owner = cert.objectRef ? vriOwnerByRef.get(cert.objectRef) : undefined;
    sources.push({
      der: cert.bytes,
      kind: owner ? 'vri' : 'dss-certs',
      signatureFieldName: owner ?? null,
      objectRef: cert.objectRef,
    });
  }

  // ---- parse and deduplicate -------------------------------------------
  const byId = new Map<string, ParsedCertificate>();
  for (const source of sources) {
    const parsed = parseCertificate(source.der);
    const existing = byId.get(parsed.id);
    const target = existing ?? parsed;
    if (!existing) byId.set(parsed.id, parsed);

    const alreadyListed = target.sources.some(
      (s) =>
        s.kind === source.kind &&
        s.signatureFieldName === source.signatureFieldName &&
        s.objectRef === source.objectRef,
    );
    if (!alreadyListed) {
      target.sources.push({
        kind: source.kind,
        signatureFieldName: source.signatureFieldName,
        objectRef: source.objectRef,
      });
    }
  }

  const certificates = Array.from(byId.values());

  // ---- tie each signature to its certificates and its signer -----------
  for (const signature of signatures) {
    const own = certificates.filter((c) =>
      c.sources.some((s) => s.signatureFieldName === signature.fieldName),
    );
    signature.certificateIds = own.map((c) => c.id);
    signature.signerCertificateId = identifySigner(signature, own);
  }

  return {
    signatures,
    certificates,
    signatureFieldCount: signatureFields.length,
    unsignedSignatureFieldNames,
    warnings,
  };
}

/**
 * Pick out which of a signature's certificates actually did the signing.
 *
 * CMS names the signer by issuer-and-serial or by subject key identifier. When
 * neither resolves -- a legacy /Cert signature, say -- fall back to the one
 * certificate that is not a CA, and give up rather than guess if that is
 * ambiguous. A wrong answer here would mislabel the whole chain.
 */
export function identifySigner(
  signature: ExtractedSignature,
  candidates: ParsedCertificate[],
): string | null {
  if (candidates.length === 0) return null;

  const sid = signature.signerSid;
  if (sid) {
    const match =
      sid.type === 'issuerAndSerial'
        ? candidates.find(
            (c) => c.serialNumber.replace(/^0+/, '') === sid.serial.replace(/^0+/, ''),
          )
        : candidates.find((c) => c.extensions.subjectKeyIdentifier === sid.ski);

    // When the CMS names its signer and that certificate is not here, say so.
    // Falling through to the heuristics below would confidently name a
    // certificate the signature never claimed -- worse than admitting it is
    // missing, which is exactly what the panel needs to report.
    return match ? match.id : null;
  }

  const endEntities = candidates.filter((c) => !c.parseError && c.extensions.basicConstraints?.isCa !== true);
  if (endEntities.length === 1) return endEntities[0].id;
  if (candidates.length === 1) return candidates[0].id;
  return null;
}

export default {
  findCmsSlot,
  readCmsFromSlot,
  readCmsFromSlotDetailed,
  readCmsFacts,
  signedByteRangeSlice,
  extractCertificateSources,
  identifySigner,
};
