import { describe, it, expect, beforeAll } from 'vitest';
import {
  findCmsSlot,
  readCmsFromSlot,
  readCmsFromSlotDetailed,
  readCmsFacts,
  signedByteRangeSlice,
  extractCertificateSources,
  identifySigner,
  type ExtractedSignature,
} from '../../lib/PdfCertificateExtractor';
import * as pkijs from 'pkijs';
import * as asn1js from 'asn1js';
import PdfSignatureTool from '../../lib/PdfSignatureTool';
import { parseCertificate } from '../../lib/CertificateModel';
import { mint, mintStandardChain, type StandardChain } from './helpers/certificateFactory';
import {
  buildSignedPdfFixture,
  buildUnsignedPdfFixture,
  type SignedPdfFixture,
} from './helpers/pdfSigner';

let chain: StandardChain;
let signed: SignedPdfFixture;

beforeAll(async () => {
  chain = await mintStandardChain();
  signed = await buildSignedPdfFixture({
    signer: chain.leaf,
    chain: [chain.leaf, chain.intermediate, chain.root],
  });
}, 60000);

describe('findCmsSlot', () => {
  it('derives the slot offsets from /ByteRange', () => {
    const slot = findCmsSlot(signed.bytes, signed.byteRange);
    expect(slot).not.toBeNull();
    expect(slot!.gapStart).toBe(signed.gapStart);
    expect(slot!.gapEnd).toBe(signed.gapEnd);
    expect(slot!.hexStart).toBe(signed.gapStart + 1);
    expect(slot!.hexEnd).toBe(signed.gapEnd - 1);
    expect(slot!.capacityBytes).toBe(signed.slotCapacityBytes);
    expect(slot!.coversWholeFile).toBe(true);
    expect(slot!.trailingBytes).toBe(0);
  });

  it('checks that the bytes really are a hex string, not just that the maths works', () => {
    // Same arithmetic, but pointing at a region that is not '<...>'.
    const bytes = new Uint8Array(200);
    expect(findCmsSlot(bytes, [0, 10, 100, 100])).toBeNull();
  });

  it('accepts a slot whose delimiters are where the arithmetic says', () => {
    const bytes = new Uint8Array(40);
    bytes[10] = 0x3c; // '<'
    bytes[19] = 0x3e; // '>'
    const slot = findCmsSlot(bytes, [0, 10, 20, 20]);
    expect(slot).not.toBeNull();
    expect(slot!.capacityBytes).toBe(4);
  });

  it('rejects a /ByteRange that is not four numbers', () => {
    expect(findCmsSlot(signed.bytes, null)).toBeNull();
    expect(findCmsSlot(signed.bytes, [0, 10, 20])).toBeNull();
    expect(findCmsSlot(signed.bytes, [0, 10, 20, 30, 40])).toBeNull();
  });

  it('rejects negative, fractional or non-numeric entries', () => {
    expect(findCmsSlot(signed.bytes, [-1, 10, 20, 30])).toBeNull();
    expect(findCmsSlot(signed.bytes, [0, 10.5, 20, 30])).toBeNull();
    expect(findCmsSlot(signed.bytes, [0, NaN, 20, 30])).toBeNull();
  });

  it('rejects a range that runs past the end of the file', () => {
    expect(findCmsSlot(signed.bytes, [0, 10, 20, signed.bytes.length])).toBeNull();
    expect(findCmsSlot(new Uint8Array(50), [0, 10, 999, 0])).toBeNull();
  });

  it('rejects a gap too small to hold anything', () => {
    expect(findCmsSlot(new Uint8Array(50), [0, 10, 11, 0])).toBeNull();
  });
});

describe('readCmsFromSlot', () => {
  it('reads the DER back and trims the padding using the ASN.1 length', () => {
    const slot = findCmsSlot(signed.bytes, signed.byteRange)!;
    const cms = readCmsFromSlot(signed.bytes, slot)!;

    expect(cms).not.toBeNull();
    expect(cms.length).toBe(signed.cmsLength);
    // Trimmed to the structure, not to the whole reserved slot.
    expect(cms.length).toBeLessThan(slot.capacityBytes);
    expect(cms[0]).toBe(0x30);
  });

  it('returns null when the hex does not start a DER SEQUENCE', () => {
    const bytes = Buffer.from('<41414141>', 'latin1');
    const slot = findCmsSlot(new Uint8Array(bytes), [0, 0, 10, 0])!;
    expect(readCmsFromSlot(new Uint8Array(bytes), slot)).toBeNull();
  });

  it('returns null when there is essentially no hex in the slot', () => {
    const bytes = new Uint8Array(Buffer.from('<>>>', 'latin1'));
    expect(readCmsFromSlot(bytes, { hexStart: 1, hexEnd: 2 } as any)).toBeNull();
  });

  it('reads a short-form DER length', () => {
    // SEQUENCE, length 3, then three bytes, then zero padding.
    const hex = '3003010203' + '00'.repeat(8);
    const bytes = new Uint8Array(Buffer.from(`<${hex}>`, 'latin1'));
    const cms = readCmsFromSlot(bytes, { hexStart: 1, hexEnd: 1 + hex.length } as any);
    expect(cms).not.toBeNull();
    expect(cms!.length).toBe(5);
  });

  it('returns null when the declared length runs past the slot', () => {
    const hex = '30820400' + '00'.repeat(4);
    const bytes = new Uint8Array(Buffer.from(`<${hex}>`, 'latin1'));
    expect(readCmsFromSlot(bytes, { hexStart: 1, hexEnd: 1 + hex.length } as any)).toBeNull();
  });

  it('returns null for an unreasonable long-form length header', () => {
    const hex = '3085' + '00'.repeat(10);
    const bytes = new Uint8Array(Buffer.from(`<${hex}>`, 'latin1'));
    expect(readCmsFromSlot(bytes, { hexStart: 1, hexEnd: 1 + hex.length } as any)).toBeNull();
  });

  it('reads a BER indefinite-length structure, stopping at its terminator', () => {
    // SEQUENCE (indefinite) { INTEGER 1 }, then slot padding.
    const hex = '308002010100' + '00' + '00'.repeat(8);
    const bytes = new Uint8Array(Buffer.from(`<${hex}>`, 'latin1'));
    const read = readCmsFromSlotDetailed(bytes, { hexStart: 1, hexEnd: 1 + hex.length } as any);

    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.encoding).toBe('indefinite');
    expect(Buffer.from(read.cms).toString('hex')).toBe('308002010100' + '00');
  });
});

describe('readCmsFromSlotDetailed: what it says when it cannot read a signature', () => {
  const readHex = (hex: string) =>
    readCmsFromSlotDetailed(new Uint8Array(Buffer.from(`<${hex}>`, 'latin1')), {
      hexStart: 1,
      hexEnd: 1 + hex.length,
    } as any);

  it('reports the encoding of a normal DER signature', () => {
    const slot = findCmsSlot(signed.bytes, signed.byteRange)!;
    const read = readCmsFromSlotDetailed(signed.bytes, slot);
    expect(read.ok && read.encoding).toBe('definite');
  });

  it('distinguishes an empty reserved slot from a broken one', () => {
    const read = readHex('00'.repeat(64));
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.reason).toBe('empty-slot');
    expect(read.detail).toContain('prepared for signing');
  });

  it('names the bytes it found when the content is not ASN.1', () => {
    const read = readHex('41414141' + '00'.repeat(4));
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.reason).toBe('not-asn1');
    expect(read.detail).toContain('41 41 41 41');
  });

  it('says the content is truncated, with both numbers', () => {
    const read = readHex('30820400' + '00'.repeat(4));
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.reason).toBe('truncated');
    expect(read.detail).toContain('1028 bytes');
    expect(read.detail).toContain('8 are present');
  });

  it('reports a length header no signature would declare', () => {
    const read = readHex('3085' + '11'.repeat(10));
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.reason).toBe('unreadable');
    expect(read.detail).toContain('30 85');
  });

  it('reports an indefinite-length structure it cannot walk', () => {
    // Opens indefinitely, then a child claiming far more bytes than are here.
    const read = readHex('3080' + '02820400' + '00'.repeat(4));
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.reason).toBe('unreadable');
    expect(read.detail).toContain('BER indefinite lengths');
  });

  it('reports a slot with no hex in it at all', () => {
    const bytes = new Uint8Array(Buffer.from('<>>>', 'latin1'));
    const read = readCmsFromSlotDetailed(bytes, { hexStart: 1, hexEnd: 2 } as any);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.reason).toBe('no-hex');
  });

  it('reports a slot holding a single byte', () => {
    const read = readHex('30');
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.reason).toBe('no-hex');
  });
});

describe('signatures written with BER indefinite lengths', () => {
  it('reads the same certificates and signer as the DER form', async () => {
    const fx = await buildSignedPdfFixture({
      signer: chain.leaf,
      chain: [chain.leaf, chain.intermediate, chain.root],
      berIndefiniteLength: true,
    });

    // 30 80: a SEQUENCE that never says how long it is.
    const slot = findCmsSlot(fx.bytes, fx.byteRange)!;
    const read = readCmsFromSlotDetailed(fx.bytes, slot);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.encoding).toBe('indefinite');
    expect(read.cms[0]).toBe(0x30);
    expect(read.cms[1]).toBe(0x80);
    expect(read.cms.length).toBe(fx.cmsLength);

    const extraction = await extractCertificateSources(fx.bytes);
    expect(extraction.signatures[0].cmsError).toBeNull();
    expect(extraction.signatures[0].cmsSlot?.encoding).toBe('indefinite');
    expect(extraction.certificates).toHaveLength(3);
    expect(extraction.signatures[0].signerCertificateId).toBe(
      parseCertificate(chain.leaf.der).id,
    );
  }, 60000);
});

describe('readCmsFacts', () => {
  it('reads the certificates, signer identifier and algorithms out of a real CMS', () => {
    const slot = findCmsSlot(signed.bytes, signed.byteRange)!;
    const facts = readCmsFacts(readCmsFromSlot(signed.bytes, slot)!);

    expect(facts.certificates).toHaveLength(3);
    expect(facts.signerSid?.type).toBe('issuerAndSerial');
    expect(facts.digestAlgorithm).toBe('SHA-256');
    expect(facts.signatureAlgorithm).toBe('ECDSA with SHA-256');
    expect(facts.signedAttributes.contentType).toBeTruthy();
    expect(facts.signedAttributes.messageDigest).toMatch(/^[0-9A-F]{64}$/);
    expect(facts.signedAttributes.signingTime).toBeTruthy();
    expect(facts.hasTimestampToken).toBe(false);
  });

  it('rejects a well-formed structure that is not SignedData', () => {
    // A valid ContentInfo, but wrapping plain data rather than SignedData.
    const contentInfo = new pkijs.ContentInfo({
      contentType: '1.2.840.113549.1.7.1',
      content: new asn1js.OctetString({ valueHex: new Uint8Array([1, 2, 3]).buffer }),
    });
    const der = new Uint8Array(contentInfo.toSchema().toBER(false));
    expect(() => readCmsFacts(der)).toThrow(/rather than CMS SignedData/i);
  });

  it('throws on bytes that are not CMS at all', () => {
    expect(() => readCmsFacts(new Uint8Array([0x30, 0x03, 0x02, 0x01, 0x01]))).toThrow();
  });

  it('reports a missing signing-time attribute as absent rather than guessing', async () => {
    const fx = await buildSignedPdfFixture({ omitSigningTime: true });
    const slot = findCmsSlot(fx.bytes, fx.byteRange)!;
    const facts = readCmsFacts(readCmsFromSlot(fx.bytes, slot)!);
    expect(facts.signedAttributes.signingTime).toBeNull();
    expect(facts.signedAttributes.messageDigest).toBeTruthy();
  }, 30000);
});

describe('signedByteRangeSlice', () => {
  it('joins the two covered spans and leaves the signature blob out', () => {
    const slice = signedByteRangeSlice(signed.bytes, signed.byteRange);
    const [a, b, c, d] = signed.byteRange;

    expect(slice.length).toBe(b + d);
    expect(slice.length).toBe(signed.bytes.length - (signed.gapEnd - signed.gapStart));
    expect(slice.subarray(0, 8).toString('latin1')).toBe(
      Buffer.from(signed.bytes.subarray(0, 8)).toString('latin1'),
    );
  });
});

describe('extractCertificateSources: a signed PDF', () => {
  it('finds the signature and every certificate in its CMS', async () => {
    const result = await extractCertificateSources(signed.bytes);

    expect(result.warnings).toEqual([]);
    expect(result.signatures).toHaveLength(1);
    expect(result.certificates).toHaveLength(3);
    expect(result.signatureFieldCount).toBe(1);
    expect(result.unsignedSignatureFieldNames).toEqual([]);
  });

  it('reads the signature dictionary without mangling anything', async () => {
    const { signatures } = await extractCertificateSources(signed.bytes);
    const sig = signatures[0];

    expect(sig.fieldName).toBe('Signature1');
    expect(sig.subFilter).toBe('adbe.pkcs7.detached');
    expect(sig.filter).toBe('Adobe.PPKLite');
    expect(sig.name).toBe('Jane Doe');
    expect(sig.reason).toBe('Testing pdf-seal');
    expect(sig.location).toBe('Prague');
    expect(sig.page).toBe(0);
    expect(sig.cmsError).toBeNull();
    expect(sig.signingTimeClaimed).toBeTruthy();
    expect(new Date(sig.signingTimeClaimed!).getTime()).not.toBeNaN();
  });

  it('records how much room is left in the signature slot', async () => {
    const { signatures } = await extractCertificateSources(signed.bytes);
    const slot = signatures[0].cmsSlot!;

    expect(slot.derLength).toBe(signed.cmsLength);
    expect(slot.headroomBytes).toBe(slot.capacityBytes - slot.derLength);
    expect(slot.headroomBytes).toBeGreaterThan(0);
  });

  it('identifies the signer certificate from the CMS signer identifier', async () => {
    const result = await extractCertificateSources(signed.bytes);
    const signer = result.certificates.find((c) => c.id === result.signatures[0].signerCertificateId);
    expect(signer?.subject.commonName).toBe('Jane Doe');
  });

  it('identifies the signer when the CMS uses a subject key identifier instead', async () => {
    const fx = await buildSignedPdfFixture({ useSubjectKeyIdentifier: true });
    const result = await extractCertificateSources(fx.bytes);

    expect(result.signatures[0].signerSid?.type).toBe('subjectKeyIdentifier');
    const signer = result.certificates.find((c) => c.id === result.signatures[0].signerCertificateId);
    expect(signer?.subject.commonName).toBe('Jane Doe');
  }, 30000);

  it('tags every certificate with the signature it came from', async () => {
    const result = await extractCertificateSources(signed.bytes);
    for (const cert of result.certificates) {
      expect(cert.sources).toEqual([
        { kind: 'cms', signatureFieldName: 'Signature1', objectRef: expect.any(String) },
      ]);
    }
  });

  it('notices when content was appended after the signed region', async () => {
    const fx = await buildSignedPdfFixture({ appendTrailingBytes: 64 });
    const { signatures } = await extractCertificateSources(fx.bytes);
    const slot = signatures[0].cmsSlot!;

    expect(slot.coversWholeFile).toBe(false);
    expect(slot.trailingBytes).toBe(64);
  }, 30000);

  it('still reads a document whose content was tampered with after signing', async () => {
    // Extraction must not fall over -- reporting the broken digest is the
    // report layer's job, and it needs the certificates to do it.
    const fx = await buildSignedPdfFixture({ tamperWithContent: true });
    const { signatures, certificates } = await extractCertificateSources(fx.bytes);

    expect(signatures[0].cmsError).toBeNull();
    expect(certificates.length).toBeGreaterThan(0);
  }, 30000);
});

describe('extractCertificateSources: other certificate sources', () => {
  it('reads certificates out of /DSS /Certs', async () => {
    const fx = await buildSignedPdfFixture({
      signer: chain.leaf,
      chain: [chain.leaf],
      dssCertificates: [chain.intermediate, chain.root],
    });
    const result = await extractCertificateSources(fx.bytes);

    expect(result.certificates).toHaveLength(3);
    const kinds = result.certificates.map((c) => c.sources[0].kind);
    expect(kinds).toEqual(['cms', 'dss-certs', 'dss-certs']);

    // Without /VRI they belong to the document, not to a signature.
    const dssCerts = result.certificates.filter((c) => c.sources[0].kind === 'dss-certs');
    expect(dssCerts.every((c) => c.sources[0].signatureFieldName === null)).toBe(true);
    expect(result.signatures[0].certificateIds).toHaveLength(1);
  }, 30000);

  it('attributes DSS certificates to a signature when /VRI says who they belong to', async () => {
    const fx = await buildSignedPdfFixture({
      signer: chain.leaf,
      chain: [chain.leaf],
      dssCertificates: [chain.intermediate, chain.root],
      dssVri: true,
    });
    const result = await extractCertificateSources(fx.bytes);

    const kinds = result.certificates.map((c) => c.sources[0].kind);
    expect(kinds).toEqual(['cms', 'vri', 'vri']);
    expect(result.certificates.every((c) => c.sources[0].signatureFieldName === 'Signature1')).toBe(true);
    expect(result.signatures[0].certificateIds).toHaveLength(3);
  }, 30000);

  it('deduplicates a certificate that appears in more than one place', async () => {
    // The leaf is in the CMS and in the DSS: one entry, two sources.
    const fx = await buildSignedPdfFixture({
      signer: chain.leaf,
      chain: [chain.leaf],
      dssCertificates: [chain.leaf],
    });
    const result = await extractCertificateSources(fx.bytes);

    expect(result.certificates).toHaveLength(1);
    expect(result.certificates[0].sources.map((s) => s.kind)).toEqual(['cms', 'dss-certs']);
  }, 30000);
});

describe('extractCertificateSources: documents with nothing to find', () => {
  it('reports an unsigned signature field without inventing a signature', async () => {
    const bytes = await buildUnsignedPdfFixture('Signature1');
    const result = await extractCertificateSources(bytes);

    expect(result.signatures).toEqual([]);
    expect(result.certificates).toEqual([]);
    expect(result.signatureFieldCount).toBe(1);
    expect(result.unsignedSignatureFieldNames).toEqual(['Signature1']);
    expect(result.warnings).toEqual([]);
  });

  it('handles a PDF with no form fields at all', async () => {
    const tool = await PdfSignatureTool.create();
    tool.addPage();
    const result = await extractCertificateSources(await tool.toBytes());

    expect(result.signatureFieldCount).toBe(0);
    expect(result.certificates).toEqual([]);
  });

  it('reports an unopenable file as a warning instead of throwing', async () => {
    const result = await extractCertificateSources(new Uint8Array([1, 2, 3, 4]));
    expect(result.warnings).toHaveLength(1);
    expect(result.signatures).toEqual([]);
  });
});

describe('extractCertificateSources: malformed signatures', () => {
  it('explains a /ByteRange that does not point at a hex string', async () => {
    // What a file modified after signing looks like: the PDF still parses, but
    // the offsets no longer land on the signature's own hex string.
    const fx = await buildSignedPdfFixture({ corruptByteRange: true });
    const { signatures } = await extractCertificateSources(fx.bytes);

    expect(signatures).toHaveLength(1);
    expect(signatures[0].cmsSlot).toBeNull();
    expect(signatures[0].cmsError).toMatch(/does not point at a hex string/i);
  }, 30000);

  it('explains signature content that is not valid CMS', async () => {
    // Overwrite the DER header so the slot parses as hex but not as CMS.
    const broken = new Uint8Array(signed.bytes);
    Buffer.from(broken.buffer, broken.byteOffset, broken.byteLength).write(
      '3003010203',
      signed.gapStart + 1,
      'latin1',
    );

    const { signatures, certificates } = await extractCertificateSources(broken);
    expect(signatures[0].cmsError).toBeTruthy();
    expect(certificates).toEqual([]);
  });
});

describe('identifySigner', () => {
  const base: ExtractedSignature = {
    fieldName: 'Signature1',
    page: 0,
    filter: null,
    subFilter: null,
    name: null,
    reason: null,
    location: null,
    contactInfo: null,
    signingTimeClaimed: null,
    byteRange: null,
    cmsSlot: null,
    cmsError: null,
    signerSid: null,
    digestAlgorithm: null,
    signatureAlgorithm: null,
    signedAttributes: { contentType: null, messageDigest: null, signingTime: null, others: [] },
    hasTimestampToken: false,
    docMdpLevel: null,
    objectRef: null,
    contentsSha1: null,
    certificateIds: [],
    signerCertificateId: null,
  };

  it('returns null when there are no certificates to choose from', () => {
    expect(identifySigner(base, [])).toBeNull();
  });

  it('matches on serial number, ignoring leading zeros', () => {
    const leaf = parseCertificate(chain.leaf.der);
    const root = parseCertificate(chain.root.der);
    const sid = {
      type: 'issuerAndSerial' as const,
      issuerDn: '',
      serial: `000${leaf.serialNumber}`,
    };
    expect(identifySigner({ ...base, signerSid: sid }, [root, leaf])).toBe(leaf.id);
  });

  it('matches on subject key identifier', () => {
    const leaf = parseCertificate(chain.leaf.der);
    const root = parseCertificate(chain.root.der);
    const sid = {
      type: 'subjectKeyIdentifier' as const,
      ski: leaf.extensions.subjectKeyIdentifier!,
    };
    expect(identifySigner({ ...base, signerSid: sid }, [root, leaf])).toBe(leaf.id);
  });

  it('admits the signer is missing rather than naming a certificate it never claimed', () => {
    // The CMS says who signed it and that certificate is not here. Falling back
    // to "the only certificate present" would confidently name the wrong one.
    const intermediate = parseCertificate(chain.intermediate.der);
    const sid = { type: 'issuerAndSerial' as const, issuerDn: '', serial: 'DEADBEEF' };
    expect(identifySigner({ ...base, signerSid: sid }, [intermediate])).toBeNull();

    const skiSid = { type: 'subjectKeyIdentifier' as const, ski: 'DEADBEEF' };
    expect(identifySigner({ ...base, signerSid: skiSid }, [intermediate])).toBeNull();
  });

  it('falls back to the only end-entity certificate when there is no signer identifier', () => {
    const leaf = parseCertificate(chain.leaf.der);
    const intermediate = parseCertificate(chain.intermediate.der);
    const root = parseCertificate(chain.root.der);
    expect(identifySigner(base, [root, intermediate, leaf])).toBe(leaf.id);
  });

  it('falls back to the only certificate present', () => {
    const root = parseCertificate(chain.root.der);
    expect(identifySigner(base, [root])).toBe(root.id);
  });

  it('gives up rather than guessing between two end-entity certificates', async () => {
    const a = parseCertificate(chain.leaf.der);
    const b = parseCertificate((await mint({ commonName: 'Other Signer' })).der);
    expect(identifySigner(base, [a, b])).toBeNull();
  });
});
