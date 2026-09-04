// Builds genuinely signed PDFs for the certificate tests.
//
// This is the extractor's and modifier's code path run in reverse, and it is
// worth the effort: without a real CMS blob over a real /ByteRange, every
// message-digest and signature test could only assert 'unknown', which would
// test nothing at all.
//
// The technique is the one real signing libraries use, because it is the only
// one that works. A signature covers the whole file except its own /Contents,
// so the bytes cannot be known until the file is laid out, and the file cannot
// be laid out until the signature is known. The way out is to reserve a
// fixed-size slot first and patch it afterwards without changing any length:
//
//   1. write /ByteRange with a wide placeholder and /Contents as a run of zeros
//   2. serialise the PDF -- every offset is now final
//   3. find the slot, work out the real /ByteRange
//   4. overwrite the placeholder, padded with spaces to the identical width
//   5. digest the two covered spans, build the CMS, hex it into the slot
//
// Steps 4 and 5 are in that order on purpose: the /ByteRange bytes sit inside
// the region the signature covers, so they must be final before anything is
// digested.

import {
  PDFDocument,
  PDFName,
  PDFDict,
  PDFArray,
  PDFNumber,
  PDFString,
  PDFHexString,
} from 'pdf-lib';
import * as pkijs from 'pkijs';
import * as asn1js from 'asn1js';
import { webcrypto, createHash } from 'node:crypto';
import PdfSignatureTool from '../../../lib/PdfSignatureTool';
import { ensureCryptoEngine } from '../../../lib/CertificateModel';
import { mintStandardChain, type MintedCertificate, type StandardChain } from './certificateFactory';

ensureCryptoEngine();

/** Wide enough that a real /ByteRange always fits inside it. */
const BYTE_RANGE_PLACEHOLDER = 9999999999;

/** Exactly 40 characters -- the width of an uppercase hex SHA-1 /VRI key. */
const VRI_KEY_PLACEHOLDER = 'ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ';

export interface SignPdfOptions {
  fieldName?: string;
  /** Signer certificate and key. Defaults to a freshly minted chain's leaf. */
  signer?: MintedCertificate;
  /** Certificates to embed in the CMS, signer first. */
  chain?: MintedCertificate[];
  subFilter?: string;
  reason?: string;
  location?: string;
  signerName?: string;
  /** Bytes reserved for the CMS. Small values exercise the doesn't-fit path. */
  slotBytes?: number;
  /** Identify the signer by subject key identifier instead of issuer+serial. */
  useSubjectKeyIdentifier?: boolean;
  /** Omit the signing-time signed attribute. */
  omitSigningTime?: boolean;
  /** Omit the messageDigest signed attribute, leaving nothing to compare against. */
  omitMessageDigest?: boolean;
  /**
   * Attach an unsigned timestamp-token attribute. The content is a placeholder:
   * pdf-seal only ever reports that a timestamp is present and explicitly does
   * not verify it, so a real TSA token would prove nothing extra here.
   */
  timestampToken?: boolean;
  /** Append bytes after the signed region, as an incremental update would. */
  appendTrailingBytes?: number;
  /** Flip a byte inside the signed region, breaking the message digest. */
  tamperWithContent?: boolean;
  /**
   * Rewrite /ByteRange after signing so it no longer points at the /Contents
   * slot -- what a file modified after signing looks like. The PDF still parses;
   * only the offsets are wrong.
   */
  corruptByteRange?: boolean;
  /**
   * Put certificates directly in the signature dictionary's /Cert, the way the
   * legacy adbe.x509.rsa_sha1 subfilter does. One certificate is written as a
   * bare hex string, several as an array, matching the spec's two forms.
   */
  legacyCertificates?: MintedCertificate[];
  /** Add a /Reference /DocMDP transform, marking a certifying signature. */
  docMdpLevel?: number;
  /**
   * Write the CMS with BER indefinite lengths (`30 80 ... 00 00`) instead of
   * DER, the way a streaming signer does. Legal for CMS, and the shape that used
   * to be unreadable.
   */
  berIndefiniteLength?: boolean;
  /** Certificates to place in /DSS /Certs, as a PAdES LTV file carries them. */
  dssCertificates?: MintedCertificate[];
  /** Also add a /VRI entry attributing the DSS certificates to this signature. */
  dssVri?: boolean;
}

export interface SignedPdfFixture {
  bytes: Uint8Array;
  fieldName: string;
  chain: MintedCertificate[];
  signer: MintedCertificate;
  /** Offsets of the '<' and one-past-'>' of the /Contents slot. */
  gapStart: number;
  gapEnd: number;
  byteRange: [number, number, number, number];
  cmsLength: number;
  slotCapacityBytes: number;
}

function findContentsSlot(bytes: Uint8Array): { gapStart: number; gapEnd: number } {
  // latin1 keeps one byte to one character, so match.index is a byte offset.
  const text = Buffer.from(bytes).toString('latin1');
  const marker = /\/Contents\s*</.exec(text);
  if (!marker) throw new Error('fixture: no /Contents hex string found');
  const gapStart = marker.index + marker[0].length - 1;
  const gapEnd = text.indexOf('>', gapStart) + 1;
  if (gapEnd <= gapStart) throw new Error('fixture: unterminated /Contents hex string');
  return { gapStart, gapEnd };
}

/**
 * Rewrite the /ByteRange array in place, padding with spaces so the file length
 * and therefore every offset in it stays exactly the same.
 */
function patchByteRange(bytes: Uint8Array, byteRange: number[]): void {
  const text = Buffer.from(bytes).toString('latin1');
  const marker = /\/ByteRange\s*\[/.exec(text);
  if (!marker) throw new Error('fixture: no /ByteRange array found');

  const start = marker.index + marker[0].length;
  const end = text.indexOf(']', start);
  if (end < 0) throw new Error('fixture: unterminated /ByteRange array');

  const width = end - start;
  const replacement = ` ${byteRange.join(' ')} `.padEnd(width, ' ');
  if (replacement.length !== width) {
    throw new Error('fixture: /ByteRange placeholder is too narrow for the real values');
  }
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).write(replacement, start, 'latin1');
}

/** Length of the TLV starting at `at`, header included. */
function tlvLength(buf: Buffer, at: number): number {
  const first = buf[at + 1];
  if (first < 0x80) return 2 + first;
  const lengthBytes = first & 0x7f;
  let length = 0;
  for (let i = 0; i < lengthBytes; i++) length = length * 256 + buf[at + 2 + i];
  return 2 + lengthBytes + length;
}

/**
 * Rewrite the outer nesting of a DER blob with BER indefinite lengths.
 *
 * `T 82 lo hi <content>` becomes `T 80 <content> 00 00`: four bytes of framing
 * either way, so the blob's length does not change and it still fits the slot it
 * was measured for. Applied down the last child of each level, which for a
 * ContentInfo is contentType's sibling [0], then the SignedData inside it.
 */
function toIndefiniteLengths(der: Buffer, depth = 3): Buffer {
  if (depth === 0 || der.length < 4 || der[1] !== 0x82) return der;

  const content = der.subarray(4);
  let at = 0;
  let lastChild = 0;
  while (at < content.length) {
    lastChild = at;
    at += tlvLength(content, at);
  }
  if (at !== content.length) return der; // not the clean nesting expected

  return Buffer.concat([
    Buffer.from([der[0], 0x80]),
    content.subarray(0, lastChild),
    toIndefiniteLengths(Buffer.from(content.subarray(lastChild)), depth - 1),
    Buffer.from([0x00, 0x00]),
  ]);
}

export async function buildSignedPdfFixture(
  options: SignPdfOptions = {},
): Promise<SignedPdfFixture> {
  const {
    fieldName = 'Signature1',
    subFilter = 'adbe.pkcs7.detached',
    reason = 'Testing pdf-seal',
    location = 'Prague',
    signerName = 'Jane Doe',
    slotBytes = 4096,
    useSubjectKeyIdentifier = false,
    omitSigningTime = false,
    omitMessageDigest = false,
    timestampToken = false,
    appendTrailingBytes = 0,
    tamperWithContent = false,
    corruptByteRange = false,
    legacyCertificates,
    berIndefiniteLength = false,
    docMdpLevel,
    dssCertificates,
    dssVri = false,
  } = options;

  let { signer, chain } = options;
  if (!signer || !chain) {
    const minted: StandardChain = await mintStandardChain();
    signer = signer ?? minted.leaf;
    chain = chain ?? [minted.leaf, minted.intermediate, minted.root];
  }

  // ---- 1: lay the document out with placeholders ------------------------
  const tool = await PdfSignatureTool.create();
  tool.addPage();
  tool.addSignatureField(0, fieldName, {});

  const doc = await PDFDocument.load(await tool.toBytes(), { updateMetadata: false });
  const field = doc.getForm().getFields().find((f: any) => f.getName() === fieldName);
  if (!field) throw new Error('fixture: signature field vanished after reload');

  const context = doc.context;
  const signatureDict = context.obj({
    Type: PDFName.of('Sig'),
    Filter: PDFName.of('Adobe.PPKLite'),
    SubFilter: PDFName.of(subFilter),
    Name: PDFString.of(signerName),
    Reason: PDFString.of(reason),
    Location: PDFString.of(location),
    M: PDFString.fromDate(new Date()),
    ByteRange: context.obj([
      PDFNumber.of(0),
      PDFNumber.of(BYTE_RANGE_PLACEHOLDER),
      PDFNumber.of(BYTE_RANGE_PLACEHOLDER),
      PDFNumber.of(BYTE_RANGE_PLACEHOLDER),
    ]),
    Contents: PDFHexString.of('0'.repeat(slotBytes * 2)),
  }) as PDFDict;

  if (legacyCertificates?.length) {
    const hexed = legacyCertificates.map((c) =>
      PDFHexString.of(Buffer.from(c.der).toString('hex')),
    );
    // The spec allows either form; exercise both depending on the count.
    signatureDict.set(
      PDFName.of('Cert'),
      hexed.length === 1 ? hexed[0] : (context.obj(hexed) as PDFArray),
    );
  }

  if (typeof docMdpLevel === 'number') {
    signatureDict.set(
      PDFName.of('Reference'),
      context.obj([
        {
          Type: PDFName.of('SigRef'),
          TransformMethod: PDFName.of('DocMDP'),
          TransformParams: { Type: PDFName.of('TransformParams'), P: PDFNumber.of(docMdpLevel) },
        },
      ]),
    );
  }

  const signatureRef = context.register(signatureDict);
  (field as any).acroField.dict.set(PDFName.of('V'), signatureRef);

  // Mark the AcroForm as carrying a signature, the way a real signer would.
  const acroForm = doc.catalog.lookup(PDFName.of('AcroForm'));
  if (acroForm instanceof PDFDict) acroForm.set(PDFName.of('SigFlags'), PDFNumber.of(3));

  // ---- optional: a Document Security Store -----------------------------
  // A real PAdES file adds this in a later incremental update. Adding it before
  // signing instead keeps the fixture simple and makes no difference to what is
  // being tested, which is whether the extractor finds and attributes it.
  if (dssCertificates?.length) {
    const certRefs = dssCertificates.map((c) =>
      context.register(context.flateStream(Buffer.from(c.der))),
    );
    const dss = context.obj({ Certs: context.obj(certRefs) }) as PDFDict;

    if (dssVri) {
      // /VRI is keyed by the uppercase hex SHA-1 of the signature's /Contents,
      // which cannot be known yet. A 40-character placeholder reserves exactly
      // the right width so the real key can be written in later without moving
      // a single byte.
      const vri = context.obj({}) as PDFDict;
      vri.set(PDFName.of(VRI_KEY_PLACEHOLDER), context.obj({ Cert: context.obj(certRefs) }));
      dss.set(PDFName.of('VRI'), vri);
    }

    doc.catalog.set(PDFName.of('DSS'), context.register(dss));
  }

  let bytes = new Uint8Array(await doc.save({ useObjectStreams: false }));

  // ---- 2 & 3: locate the slot, derive the real /ByteRange ---------------
  const { gapStart, gapEnd } = findContentsSlot(bytes);
  const byteRange: [number, number, number, number] = [
    0,
    gapStart,
    gapEnd,
    bytes.length - gapEnd,
  ];

  // ---- 4: the placeholder must be final before anything is digested -----
  patchByteRange(bytes, byteRange);

  // ---- 5: digest, sign, and write the CMS into the slot ------------------
  const covered = Buffer.concat([
    Buffer.from(bytes.subarray(0, gapStart)),
    Buffer.from(bytes.subarray(gapEnd, gapEnd + byteRange[3])),
  ]);
  const digest = await webcrypto.subtle.digest('SHA-256', covered);

  const attributes = [
    new pkijs.Attribute({
      type: '1.2.840.113549.1.9.3',
      values: [new asn1js.ObjectIdentifier({ value: '1.2.840.113549.1.7.1' })],
    }),
  ];
  if (!omitMessageDigest) {
    attributes.push(
      new pkijs.Attribute({
        type: '1.2.840.113549.1.9.4',
        values: [new asn1js.OctetString({ valueHex: digest })],
      }),
    );
  }
  if (!omitSigningTime) {
    attributes.push(
      new pkijs.Attribute({
        type: '1.2.840.113549.1.9.5',
        values: [new asn1js.UTCTime({ valueDate: new Date() })],
      }),
    );
  }

  let sid: any;
  if (useSubjectKeyIdentifier) {
    const skiExtension = signer.cert.extensions?.find((e) => e.extnID === '2.5.29.14');
    if (!skiExtension) throw new Error('fixture: signer has no subject key identifier to use');
    const inner = asn1js.fromBER(skiExtension.extnValue.valueBlock.valueHexView).result as any;
    // SignerIdentifier's SKI arm is [0] IMPLICIT OCTET STRING. In asn1js an
    // implicitly-tagged primitive has to be built as a Primitive -- retagging an
    // OctetString produces something pkijs cannot parse back.
    sid = new asn1js.Primitive({
      idBlock: { tagClass: 3, tagNumber: 0 },
      valueHex: inner.valueBlock.valueHexView.slice().buffer,
    });
  } else {
    sid = new pkijs.IssuerAndSerialNumber({
      issuer: signer.cert.issuer,
      serialNumber: signer.cert.serialNumber,
    });
  }

  const signedData = new pkijs.SignedData({
    version: 1,
    encapContentInfo: new pkijs.EncapsulatedContentInfo({
      eContentType: '1.2.840.113549.1.7.1',
    }),
    signerInfos: [
      new pkijs.SignerInfo({
        version: useSubjectKeyIdentifier ? 3 : 1,
        sid,
        signedAttrs: new pkijs.SignedAndUnsignedAttributes({ type: 0, attributes }),
        ...(timestampToken
          ? {
              unsignedAttrs: new pkijs.SignedAndUnsignedAttributes({
                type: 1,
                attributes: [
                  new pkijs.Attribute({
                    type: '1.2.840.113549.1.9.16.2.14',
                    values: [new asn1js.OctetString({ valueHex: new Uint8Array([1, 2, 3]).buffer })],
                  }),
                ],
              }),
            }
          : {}),
      }),
    ],
    certificates: chain.map((c) => c.cert),
  });

  await signedData.sign(signer.privateKey, 0, 'SHA-256', undefined, pkijs.getCrypto(true));

  const cms = new pkijs.ContentInfo({
    contentType: '1.2.840.113549.1.7.2',
    content: signedData.toSchema(true),
  });
  let cmsDer = Buffer.from(cms.toSchema().toBER(false));
  if (berIndefiniteLength) {
    const converted = toIndefiniteLengths(cmsDer);
    if (converted.length !== cmsDer.length) {
      throw new Error('fixture: indefinite-length rewrite changed the CMS length');
    }
    cmsDer = converted;
  }

  const capacityBytes = Math.floor((gapEnd - gapStart - 2) / 2);
  if (cmsDer.length > capacityBytes) {
    throw new Error(
      `fixture: CMS is ${cmsDer.length} bytes but the slot holds ${capacityBytes}. Raise slotBytes.`,
    );
  }

  const hex = cmsDer.toString('hex').padEnd(capacityBytes * 2, '0');
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).write(
    hex,
    gapStart + 1,
    'latin1',
  );

  // Now that the CMS exists, its SHA-1 can replace the /VRI placeholder. Same
  // width, so nothing moves and the /ByteRange stays correct.
  if (dssVri && dssCertificates?.length) {
    const contentsSha1 = createHash('sha1').update(cmsDer).digest('hex').toUpperCase();
    const text = Buffer.from(bytes).toString('latin1');
    const at = text.indexOf(VRI_KEY_PLACEHOLDER);
    if (at < 0) throw new Error('fixture: /VRI key placeholder not found');
    Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).write(
      contentsSha1,
      at,
      'latin1',
    );
  }

  // ---- 6: damage, after the fact ----------------------------------------
  // Both of these must happen after the CMS is written, or they would simply be
  // part of what was signed and prove nothing.

  if (tamperWithContent) {
    // Flip a byte well inside the first covered span. The document no longer
    // matches the digest the signature committed to.
    const target = Math.min(200, gapStart - 1);
    bytes[target] = bytes[target] ^ 0xff;
  }

  if (corruptByteRange) {
    // Shift the offsets so the gap no longer lands on the '<...>'. The array is
    // rewritten at the same width, so the file stays structurally valid and the
    // signature dictionary still parses -- only the offsets lie.
    patchByteRange(bytes, [0, gapStart - 8, gapEnd - 8, byteRange[3]]);
  }

  if (appendTrailingBytes > 0) {
    // What a later incremental update looks like: bytes past the second signed
    // range, which /ByteRange therefore does not cover. A comment keeps the
    // file structurally valid.
    const filler = 'a'.repeat(Math.max(1, appendTrailingBytes - 2));
    bytes = new Uint8Array(
      Buffer.concat([Buffer.from(bytes), Buffer.from(`\n%${filler}`, 'latin1')]),
    );
  }

  return {
    bytes,
    fieldName,
    chain,
    signer,
    gapStart,
    gapEnd,
    byteRange,
    cmsLength: cmsDer.length,
    slotCapacityBytes: capacityBytes,
  };
}

/** A PDF with an unsigned signature field -- what pdf-seal itself produces. */
export async function buildUnsignedPdfFixture(fieldName = 'Signature1'): Promise<Uint8Array> {
  const tool = await PdfSignatureTool.create();
  tool.addPage();
  tool.addSignatureField(0, fieldName, {});
  return tool.toBytes();
}

export default { buildSignedPdfFixture, buildUnsignedPdfFixture };
