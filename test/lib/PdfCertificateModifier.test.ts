import { describe, it, expect, beforeAll } from 'vitest';
import {
  applyCertificateOperation,
  describeAvailableOperations,
  CertificateModificationError,
} from '../../lib/PdfCertificateModifier';
import { buildCertificateReport } from '../../lib/PdfCertificateReport';
import { parseCertificate } from '../../lib/CertificateModel';
import { mint, mintStandardChain, type StandardChain } from './helpers/certificateFactory';
import { buildSignedPdfFixture, buildUnsignedPdfFixture, type SignedPdfFixture } from './helpers/pdfSigner';

let chain: StandardChain;
let other: StandardChain;
let signed: SignedPdfFixture;

/** A fresh three-certificate signed PDF -- each test mutates its own copy. */
async function freshSigned() {
  return buildSignedPdfFixture({
    signer: chain.leaf,
    chain: [chain.leaf, chain.intermediate, chain.root],
  });
}

function sigCheck(report: any, id: string) {
  return report.signatures[0]?.checks.find((c: any) => c.id === id);
}

beforeAll(async () => {
  chain = await mintStandardChain();
  other = await mintStandardChain();
  signed = await freshSigned();
}, 60000);

describe('applyCertificateOperation: the write is length-preserving and local', () => {
  it('produces a file of exactly the same length', async () => {
    const result = await applyCertificateOperation(signed.bytes, {
      op: 'remove-intermediates',
      signatureField: 'Signature1',
    });
    expect(result.bytes.length).toBe(signed.bytes.length);
  });

  it('changes bytes only inside the signature slot', async () => {
    // This is the whole justification for patching in place rather than
    // re-saving: every offset in the file, including the /ByteRange that
    // describes this slot, has to survive untouched.
    const result = await applyCertificateOperation(signed.bytes, {
      op: 'remove-intermediates',
      signatureField: 'Signature1',
    });

    const before = Buffer.from(signed.bytes);
    const after = result.bytes;
    let first = -1;
    let last = -1;
    for (let i = 0; i < before.length; i++) {
      if (before[i] !== after[i]) {
        if (first < 0) first = i;
        last = i;
      }
    }

    expect(first).toBeGreaterThan(signed.gapStart);
    expect(last).toBeLessThan(signed.gapEnd);
  });

  it('leaves the original bytes untouched', async () => {
    const copy = Buffer.from(signed.bytes);
    await applyCertificateOperation(signed.bytes, {
      op: 'remove-intermediates',
      signatureField: 'Signature1',
    });
    expect(Buffer.from(signed.bytes).equals(copy)).toBe(true);
  });

  it('pads the unused tail of the slot so the result stays parseable', async () => {
    const result = await applyCertificateOperation(signed.bytes, {
      op: 'remove-intermediates',
      signatureField: 'Signature1',
    });
    expect(result.newDerLength).toBeLessThan(result.originalDerLength);
    expect(result.headroomBytes).toBe(result.slotCapacityBytes - result.newDerLength);

    // The proof it stayed parseable: the whole report can be rebuilt from it.
    const report = await buildCertificateReport(result.bytes);
    expect(report.signatures[0].cmsError).toBeNull();
  });
});

describe('applyCertificateOperation: a signature written with BER indefinite lengths', () => {
  it('modifies it, writes DER back, and says the encoding changed', async () => {
    const fx = await buildSignedPdfFixture({
      signer: chain.leaf,
      chain: [chain.leaf, chain.intermediate, chain.root],
      berIndefiniteLength: true,
    });

    const result = await applyCertificateOperation(fx.bytes, {
      op: 'remove-intermediates',
      signatureField: 'Signature1',
    });

    expect(result.bytes.length).toBe(fx.bytes.length);
    expect(result.removedCertificates).toEqual(['PDF Seal Test Signing CA']);
    expect(result.notes.some((n) => n.includes('BER indefinite lengths'))).toBe(true);

    const report = await buildCertificateReport(result.bytes);
    expect(report.signatures[0].cmsError).toBeNull();
    expect(sigCheck(report, 'sig.cryptographic')?.status).toBe('pass');
    expect(report.certificates).toHaveLength(2);
  }, 60000);
});

describe('applyCertificateOperation: remove-intermediates', () => {
  it('drops the CAs between signer and root, and says the chain is now broken', async () => {
    const result = await applyCertificateOperation(signed.bytes, {
      op: 'remove-intermediates',
      signatureField: 'Signature1',
    });

    expect(result.removedCertificates).toEqual(['PDF Seal Test Signing CA']);
    expect(result.remainingCertificates).toBe(2);

    const report = await buildCertificateReport(result.bytes);
    expect(report.certificates).toHaveLength(2);
    expect(report.chains[0].complete).toBe(false);
    expect(report.chains[0].missingIssuerDn).toContain('PDF Seal Test Signing CA');
  });

  it('does NOT break the signature, because the certificate set is not signed over', async () => {
    // The distinction that matters: removing a CA degrades chain building and
    // nothing else. Claiming otherwise would be the kind of overstatement this
    // feature exists to avoid.
    const result = await applyCertificateOperation(signed.bytes, {
      op: 'remove-intermediates',
      signatureField: 'Signature1',
    });

    expect(result.signatureNowInvalid).toBe(false);
    expect(result.notes.join(' ')).toMatch(/still verifies cryptographically/i);

    const report = await buildCertificateReport(result.bytes);
    expect(sigCheck(report, 'sig.messageDigest')?.status).toBe('pass');
    expect(sigCheck(report, 'sig.cryptographic')?.status).toBe('pass');
  });

  it('keeps the signer and the root', async () => {
    const result = await applyCertificateOperation(signed.bytes, {
      op: 'remove-intermediates',
      signatureField: 'Signature1',
    });
    const report = await buildCertificateReport(result.bytes);
    const names = report.certificates.map((c) => c.subject.commonName).sort();
    expect(names).toEqual(['Jane Doe', 'PDF Seal Test Root CA']);
  });

  it('refuses when there is no intermediate to remove', async () => {
    const fx = await buildSignedPdfFixture({ signer: chain.leaf, chain: [chain.leaf] });
    await expect(
      applyCertificateOperation(fx.bytes, { op: 'remove-intermediates', signatureField: 'Signature1' }),
    ).rejects.toThrow(/no intermediate CA certificates/i);
  }, 30000);
});

describe('applyCertificateOperation: remove-certificate', () => {
  it('removes exactly the certificate that was named', async () => {
    const report = await buildCertificateReport(signed.bytes);
    const root = report.certificates.find((c) => c.subject.commonName === 'PDF Seal Test Root CA')!;

    const result = await applyCertificateOperation(signed.bytes, {
      op: 'remove-certificate',
      signatureField: 'Signature1',
      targetFingerprint: root.id,
    });

    expect(result.removedCertificates).toEqual(['PDF Seal Test Root CA']);
    const after = await buildCertificateReport(result.bytes);
    expect(after.certificates.map((c) => c.id)).not.toContain(root.id);
    expect(after.certificates).toHaveLength(2);
  });

  it('reports that the signature broke when the removed certificate was the signer', async () => {
    const report = await buildCertificateReport(signed.bytes);
    const signer = report.certificates.find((c) => c.id === report.signatures[0].signerCertificateId)!;

    const result = await applyCertificateOperation(signed.bytes, {
      op: 'remove-certificate',
      signatureField: 'Signature1',
      targetFingerprint: signer.id,
    });

    expect(result.signatureNowInvalid).toBe(true);
    const after = await buildCertificateReport(result.bytes);
    expect(sigCheck(after, 'sig.signerIdentified')?.status).toBe('fail');
  });

  it('refuses a certificate that is not inside this signature', async () => {
    await expect(
      applyCertificateOperation(signed.bytes, {
        op: 'remove-certificate',
        signatureField: 'Signature1',
        targetFingerprint: 'f'.repeat(64),
      }),
    ).rejects.toThrow(/not inside this signature/i);
  });

  it('refuses when no certificate was named', async () => {
    await expect(
      applyCertificateOperation(signed.bytes, { op: 'remove-certificate', signatureField: 'Signature1' }),
    ).rejects.toThrow(/No certificate was selected/i);
  });
});

describe('applyCertificateOperation: replace-signer', () => {
  it('swaps the signer certificate and updates the signer identifier with it', async () => {
    const result = await applyCertificateOperation(signed.bytes, {
      op: 'replace-signer',
      signatureField: 'Signature1',
      replacementDer: [other.leaf.der],
    });

    expect(result.signatureNowInvalid).toBe(true);
    expect(result.notes.join(' ')).toMatch(/signer identifier inside the signature was updated/i);

    // Left un-updated, the signer could not be located at all -- worse than an
    // honestly broken signature.
    const after = await buildCertificateReport(result.bytes);
    expect(sigCheck(after, 'sig.signerIdentified')?.status).toBe('pass');
  });

  it('leaves the document intact but the signature no longer verifying', async () => {
    // The pair of results a tester is actually after: the content is provably
    // unchanged, and only the signature blob was tampered with.
    const result = await applyCertificateOperation(signed.bytes, {
      op: 'replace-signer',
      signatureField: 'Signature1',
      replacementDer: [other.leaf.der],
    });
    const after = await buildCertificateReport(result.bytes);

    expect(sigCheck(after, 'sig.messageDigest')?.status).toBe('pass');
    expect(sigCheck(after, 'sig.cryptographic')?.status).toBe('fail');
    expect(sigCheck(after, 'sig.cryptographic')?.explanation).toMatch(/signature blob having been altered/i);
  });

  it('refuses a replacement that is not a certificate', async () => {
    await expect(
      applyCertificateOperation(signed.bytes, {
        op: 'replace-signer',
        signatureField: 'Signature1',
        replacementDer: [new Uint8Array([1, 2, 3, 4])],
      }),
    ).rejects.toThrow(/could not be read/i);
  });

  it('refuses when no replacement was provided', async () => {
    await expect(
      applyCertificateOperation(signed.bytes, { op: 'replace-signer', signatureField: 'Signature1' }),
    ).rejects.toThrow(/No replacement certificate/i);
  });

  it('refuses when the signer is not embedded in the document', async () => {
    const absent = await mint({ commonName: 'Absent Signer', issuer: chain.intermediate });
    const fx = await buildSignedPdfFixture({ signer: absent, chain: [chain.intermediate] });
    await expect(
      applyCertificateOperation(fx.bytes, {
        op: 'replace-signer',
        signatureField: 'Signature1',
        replacementDer: [other.leaf.der],
      }),
    ).rejects.toThrow(/could not be identified/i);
  }, 30000);
});

describe('applyCertificateOperation: replace-chain', () => {
  it('swaps the CAs above the signer while keeping the signer itself', async () => {
    const result = await applyCertificateOperation(signed.bytes, {
      op: 'replace-chain',
      signatureField: 'Signature1',
      replacementDer: [other.intermediate.der, other.root.der],
    });

    expect(result.signatureNowInvalid).toBe(false);
    expect(result.removedCertificates).toHaveLength(2);
    expect(result.addedCertificates).toHaveLength(2);

    const after = await buildCertificateReport(result.bytes);
    expect(after.certificates).toHaveLength(3);
    // The signer survived, so the signature still verifies.
    expect(sigCheck(after, 'sig.cryptographic')?.status).toBe('pass');
  });

  it('produces a chain that resolves by name but fails cryptographically', async () => {
    // The replacement CA carries the same subject name as the one it displaced,
    // so the chain still builds and still looks complete. Only the key
    // identifier and the issuer signature reveal that this CA did not issue the
    // signer -- which is the whole reason the cryptographic check exists, and a
    // genuinely useful document to hand a verifier under test.
    const result = await applyCertificateOperation(signed.bytes, {
      op: 'replace-chain',
      signatureField: 'Signature1',
      replacementDer: [other.intermediate.der, other.root.der],
    });
    const after = await buildCertificateReport(result.bytes);
    const chainResult = after.chains[0];
    const signerLink = chainResult.links[0];
    const byId = (id: string) => signerLink.checks.find((c) => c.id === id)?.status;

    expect(chainResult.complete).toBe(true);
    expect(byId('link.dn')).toBe('pass');
    expect(byId('link.akiSki')).toBe('fail');
    expect(byId('link.cryptographic')).toBe('fail');

    expect(chainResult.checks.find((c) => c.id === 'chain.issuerRelationship')?.status).toBe('fail');
    expect(after.summary.status).toBe('fail');
  });

  it('refuses when no replacements were provided', async () => {
    await expect(
      applyCertificateOperation(signed.bytes, { op: 'replace-chain', signatureField: 'Signature1' }),
    ).rejects.toThrow(/No replacement certificates/i);
  });

  it('refuses an unreadable replacement', async () => {
    await expect(
      applyCertificateOperation(signed.bytes, {
        op: 'replace-chain',
        signatureField: 'Signature1',
        replacementDer: [new Uint8Array([0x30, 0x03, 0x02, 0x01, 0x01])],
      }),
    ).rejects.toThrow(/could not be read/i);
  });
});

describe('applyCertificateOperation: refusals', () => {
  it('refuses when the slot is too small, naming both sizes', async () => {
    const tight = await buildSignedPdfFixture({
      signer: chain.leaf,
      chain: [chain.leaf],
      slotBytes: 1100,
    });
    await expect(
      applyCertificateOperation(tight.bytes, {
        op: 'replace-chain',
        signatureField: 'Signature1',
        replacementDer: [other.intermediate.der, other.root.der],
      }),
    ).rejects.toThrow(/is \d+ bytes but the space reserved for it in this PDF holds only 1100/);
  }, 30000);

  it('refuses a signature field that is not in the document', async () => {
    await expect(
      applyCertificateOperation(signed.bytes, { op: 'remove-intermediates', signatureField: 'Nope' }),
    ).rejects.toThrow(/no signed signature field called "Nope"/i);
  });

  it('refuses a document with no signatures at all', async () => {
    const bytes = await buildUnsignedPdfFixture('Signature1');
    await expect(
      applyCertificateOperation(bytes, { op: 'remove-intermediates', signatureField: 'Signature1' }),
    ).rejects.toThrow(/no signed signature field/i);
  });

  it('refuses when the signature content cannot be located', async () => {
    const fx = await buildSignedPdfFixture({ corruptByteRange: true });
    await expect(
      applyCertificateOperation(fx.bytes, { op: 'remove-intermediates', signatureField: 'Signature1' }),
    ).rejects.toThrow(/does not point at a hex string|cannot be modified/i);
  }, 30000);

  it('refuses an unknown operation', async () => {
    await expect(
      applyCertificateOperation(signed.bytes, { op: 'nonsense' as any, signatureField: 'Signature1' }),
    ).rejects.toThrow(/Unknown operation/i);
  });

  it('raises a user-facing error type', async () => {
    await expect(
      applyCertificateOperation(signed.bytes, { op: 'remove-intermediates', signatureField: 'Nope' }),
    ).rejects.toBeInstanceOf(CertificateModificationError);
  });
});

describe('describeAvailableOperations', () => {
  it('offers every operation on a full three-certificate chain', async () => {
    const report = await buildCertificateReport(signed.bytes);
    const ops = describeAvailableOperations(report.signatures[0], report.certificates);

    expect(ops.every((o) => o.available)).toBe(true);
    expect(ops.every((o) => o.reason === null)).toBe(true);
    expect(ops.map((o) => o.op)).toEqual([
      'remove-certificate',
      'remove-intermediates',
      'replace-signer',
      'replace-chain',
    ]);
  });

  it('explains which operations a single-certificate signature cannot support', async () => {
    const fx = await buildSignedPdfFixture({ signer: chain.leaf, chain: [chain.leaf] });
    const report = await buildCertificateReport(fx.bytes);
    const ops = describeAvailableOperations(report.signatures[0], report.certificates);
    const byOp = Object.fromEntries(ops.map((o) => [o.op, o]));

    expect(byOp['remove-certificate'].available).toBe(false);
    expect(byOp['remove-certificate'].reason).toMatch(/only one certificate/i);
    expect(byOp['remove-intermediates'].available).toBe(false);
    expect(byOp['replace-chain'].available).toBe(false);
    expect(byOp['replace-chain'].reason).toMatch(/no CA certificates above the signer/i);
    // The signer is present, so replacing it is still possible.
    expect(byOp['replace-signer'].available).toBe(true);
  }, 30000);

  it('explains that nothing can be replaced when the signer is absent', async () => {
    const absent = await mint({ commonName: 'Absent Signer', issuer: chain.intermediate });
    const fx = await buildSignedPdfFixture({ signer: absent, chain: [chain.intermediate] });
    const report = await buildCertificateReport(fx.bytes);
    const ops = describeAvailableOperations(report.signatures[0], report.certificates);
    const byOp = Object.fromEntries(ops.map((o) => [o.op, o]));

    expect(byOp['replace-signer'].available).toBe(false);
    expect(byOp['replace-signer'].reason).toMatch(/not embedded in the document/i);
    expect(byOp['replace-chain'].available).toBe(false);
  }, 30000);
});

describe('applyCertificateOperation: signer identified by key identifier', () => {
  it('warns that the identifier could not be updated, instead of silently leaving it wrong', async () => {
    // A CMS that names its signer by subject key identifier cannot have that
    // identifier rewritten to match a replacement, so the replacement may not
    // be matchable to the signature at all. Saying so is the honest outcome.
    const fx = await buildSignedPdfFixture({
      signer: chain.leaf,
      chain: [chain.leaf, chain.intermediate, chain.root],
      useSubjectKeyIdentifier: true,
    });

    const result = await applyCertificateOperation(fx.bytes, {
      op: 'replace-signer',
      signatureField: 'Signature1',
      replacementDer: [other.leaf.der],
    });

    expect(result.signatureNowInvalid).toBe(true);
    expect(result.notes.join(' ')).toMatch(/subject key identifier, which was left as it was/i);
    expect(result.notes.join(' ')).not.toMatch(/signer identifier inside the signature was updated/i);
  }, 30000);
});

describe('applyCertificateOperation: a signature carrying no certificates', () => {
  it('refuses rather than producing an empty certificate set', async () => {
    const fx = await buildSignedPdfFixture({ signer: chain.leaf, chain: [] });
    await expect(
      applyCertificateOperation(fx.bytes, {
        op: 'remove-intermediates',
        signatureField: 'Signature1',
      }),
    ).rejects.toThrow(/carries no certificates/i);
  }, 30000);
});
