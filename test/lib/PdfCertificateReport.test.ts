import { describe, it, expect, beforeAll } from 'vitest';
import { buildCertificateReport, collectAllChecks } from '../../lib/PdfCertificateReport';
import PdfSignatureTool from '../../lib/PdfSignatureTool';
import { TRUST_NOTE } from '../../lib/CertificateChain';
import { mint, mintStandardChain, type StandardChain } from './helpers/certificateFactory';
import { buildSignedPdfFixture, buildUnsignedPdfFixture } from './helpers/pdfSigner';

let chain: StandardChain;
let cleanReport: Awaited<ReturnType<typeof buildCertificateReport>>;

function sigCheck(report: any, id: string, field = 'Signature1') {
  return report.signatures.find((s: any) => s.fieldName === field)?.checks.find((c: any) => c.id === id);
}

beforeAll(async () => {
  chain = await mintStandardChain();
  const fx = await buildSignedPdfFixture({
    signer: chain.leaf,
    chain: [chain.leaf, chain.intermediate, chain.root],
  });
  cleanReport = await buildCertificateReport(fx.bytes);
}, 60000);

describe('buildCertificateReport: a signature written with BER indefinite lengths', () => {
  it('reads it, says so, and still verifies it', async () => {
    const fx = await buildSignedPdfFixture({
      signer: chain.leaf,
      chain: [chain.leaf, chain.intermediate, chain.root],
      berIndefiniteLength: true,
    });
    const report = await buildCertificateReport(fx.bytes);

    const slotCheck = sigCheck(report, 'sig.contentsSlot');
    expect(slotCheck?.status).toBe('pass');
    expect(slotCheck?.detail).toContain('BER indefinite-length');
    expect(sigCheck(report, 'sig.messageDigest')?.status).toBe('pass');
    expect(sigCheck(report, 'sig.cryptographic')?.status).toBe('pass');
    expect(report.certificates).toHaveLength(3);
  }, 60000);
});

describe('buildCertificateReport: a properly signed document', () => {
  it('reports the signature, the certificates and one chain', () => {
    expect(cleanReport.documentHasSignatures).toBe(true);
    expect(cleanReport.signatures).toHaveLength(1);
    expect(cleanReport.certificates).toHaveLength(3);
    expect(cleanReport.chains).toHaveLength(1);
    expect(cleanReport.chains[0].complete).toBe(true);
    expect(cleanReport.signatures[0].chainId).toBe(cleanReport.chains[0].id);
    expect(cleanReport.truncated).toBe(false);
    expect(cleanReport.warnings).toEqual([]);
  });

  it('verifies the document is unchanged and the signature is genuine', () => {
    expect(sigCheck(cleanReport, 'sig.messageDigest')?.status).toBe('pass');
    expect(sigCheck(cleanReport, 'sig.cryptographic')?.status).toBe('pass');
    expect(sigCheck(cleanReport, 'sig.signerIdentified')?.status).toBe('pass');
    expect(sigCheck(cleanReport, 'sig.byteRangeCoverage')?.status).toBe('pass');
    expect(sigCheck(cleanReport, 'sig.contentsSlot')?.status).toBe('pass');
  });

  it('assigns each certificate its role from its position in the chain', () => {
    const roles = cleanReport.chains[0].certificateIds.map(
      (id) => cleanReport.certificates.find((c) => c.id === id)!.role,
    );
    expect(roles).toEqual(['signer', 'intermediate', 'root']);
  });

  it('gives every certificate its own checks', () => {
    for (const cert of cleanReport.certificates) {
      expect(cert.checks.length).toBeGreaterThan(0);
      expect(cert.checks.find((c) => c.id === 'cert.parse')?.status).toBe('pass');
    }
  });

  it('states plainly that trust was never evaluated', () => {
    expect(cleanReport.trust.hasTrustStore).toBe(false);
    expect(cleanReport.trust.note).toBe(TRUST_NOTE);
    expect(cleanReport.chains[0].checks.find((c) => c.id === 'chain.trust')?.status).toBe('unknown');
    expect(cleanReport.chains[0].checks.find((c) => c.id === 'chain.revocation')?.status).toBe(
      'unknown',
    );
  });

  it('does not let the always-unknown trust checks drag the headline verdict down', () => {
    // Trust and revocation are unknown by design; if they counted, every
    // document would report as unresolved and the verdict would be useless.
    expect(cleanReport.summary.counts.unknown).toBeGreaterThan(0);
    expect(cleanReport.summary.status).not.toBe('unknown');
  });

  it('warns that the signing time is only a claim when nothing timestamps it', () => {
    const check = sigCheck(cleanReport, 'sig.timestamp');
    expect(check?.status).toBe('warn');
    expect(check?.explanation).toMatch(/signer’s own claim/i);
  });

  it('gives every check a label, a detail and an explanation', () => {
    const all = [
      ...cleanReport.signatures.flatMap((s) => s.checks),
      ...cleanReport.chains.flatMap((c) => c.checks),
      ...cleanReport.certificates.flatMap((c) => c.checks),
    ];
    expect(all.length).toBeGreaterThan(20);
    for (const check of all) {
      expect(check.id).toBeTruthy();
      expect(check.label).toBeTruthy();
      expect(check.detail).toBeTruthy();
      expect(check.explanation.length).toBeGreaterThan(20);
      expect(['pass', 'warn', 'fail', 'unknown']).toContain(check.status);
    }
  });

  it('is JSON-serialisable, since it is sent straight to the browser', () => {
    const round = JSON.parse(JSON.stringify(cleanReport));
    expect(round.certificates[0].pem).toContain('BEGIN CERTIFICATE');
    expect(round.summary.status).toBe(cleanReport.summary.status);
  });
});

describe('buildCertificateReport: a document modified after signing', () => {
  it('says the document changed, not that the signature is forged', async () => {
    const fx = await buildSignedPdfFixture({ tamperWithContent: true });
    const report = await buildCertificateReport(fx.bytes);

    expect(sigCheck(report, 'sig.messageDigest')?.status).toBe('fail');
    const crypto = sigCheck(report, 'sig.cryptographic');
    expect(crypto?.status).toBe('fail');
    expect(crypto?.detail).toMatch(/document changed after signing/i);
    expect(crypto?.explanation).toMatch(/signature blob itself may still be intact/i);
    expect(report.summary.status).toBe('fail');
  }, 30000);

  it('flags bytes appended after the signed region without crying wolf', async () => {
    const fx = await buildSignedPdfFixture({ appendTrailingBytes: 48 });
    const report = await buildCertificateReport(fx.bytes);

    const coverage = sigCheck(report, 'sig.byteRangeCoverage');
    expect(coverage?.status).toBe('warn');
    expect(coverage?.detail).toContain('48');
    expect(coverage?.explanation).toMatch(/incremental update/i);

    // The signature itself is still perfectly valid.
    expect(sigCheck(report, 'sig.messageDigest')?.status).toBe('pass');
    expect(sigCheck(report, 'sig.cryptographic')?.status).toBe('pass');
  }, 30000);

  it('explains a signature whose content cannot be located', async () => {
    const fx = await buildSignedPdfFixture({ corruptByteRange: true });
    const report = await buildCertificateReport(fx.bytes);

    const slot = sigCheck(report, 'sig.contentsSlot');
    expect(slot?.status).toBe('fail');
    // With no readable content there is nothing further to claim.
    expect(sigCheck(report, 'sig.cryptographic')).toBeUndefined();
    expect(report.summary.status).toBe('fail');
  }, 30000);
});

describe('buildCertificateReport: incomplete chains', () => {
  it('warns rather than fails when the root is not embedded', async () => {
    const fx = await buildSignedPdfFixture({
      signer: chain.leaf,
      chain: [chain.leaf, chain.intermediate],
    });
    const report = await buildCertificateReport(fx.bytes);

    expect(report.chains[0].complete).toBe(false);
    expect(report.chains[0].checks.find((c) => c.id === 'chain.root')?.status).toBe('warn');
    expect(report.summary.status).toBe('warn');
    // The signature itself is untouched by the chain being short.
    expect(sigCheck(report, 'sig.cryptographic')?.status).toBe('pass');
  }, 30000);

  it('names the intermediate it needs when one is missing', async () => {
    const fx = await buildSignedPdfFixture({
      signer: chain.leaf,
      chain: [chain.leaf, chain.root],
    });
    const report = await buildCertificateReport(fx.bytes);

    expect(report.chains[0].missingIssuerDn).toContain('PDF Seal Test Signing CA');
    const check = report.chains[0].checks.find((c) => c.id === 'chain.missingIntermediate');
    expect(check?.status).toBe('warn');

    // The root came along but no chain reaches it.
    const rootCert = report.certificates.find((c) => c.subject.commonName === 'PDF Seal Test Root CA');
    expect(report.unchainedCertificateIds).toContain(rootCert!.id);
  }, 30000);

  it('fails when the signer certificate is not in the document at all', async () => {
    const orphan = await mint({ commonName: 'Absent Signer', issuer: chain.intermediate });
    const fx = await buildSignedPdfFixture({ signer: orphan, chain: [chain.intermediate] });
    const report = await buildCertificateReport(fx.bytes);

    const check = sigCheck(report, 'sig.signerIdentified');
    expect(check?.status).toBe('fail');
    expect(check?.explanation).toMatch(/not embedded in the PDF/i);
  }, 30000);
});

describe('buildCertificateReport: documents with no certificates', () => {
  it('explains an unsigned document rather than erroring', async () => {
    const report = await buildCertificateReport(await buildUnsignedPdfFixture('Signature1'));

    expect(report.documentHasSignatures).toBe(false);
    expect(report.signatures).toEqual([]);
    expect(report.certificates).toEqual([]);
    expect(report.chains).toEqual([]);
    expect(report.signatureFieldCount).toBe(1);
    expect(report.unsignedSignatureFieldNames).toEqual(['Signature1']);
    expect(report.summary.status).toBe('unknown');
    expect(report.summary.headline).toMatch(/has not been signed yet/i);
    // Even here, the trust position is stated rather than left implied.
    expect(report.trust.note).toBe(TRUST_NOTE);
  });

  it('explains a document with no signature fields at all', async () => {
    const tool = await PdfSignatureTool.create();
    tool.addPage();
    const report = await buildCertificateReport(await tool.toBytes());

    expect(report.signatureFieldCount).toBe(0);
    expect(report.summary.headline).toMatch(/not signed and carries no certificates/i);
  });

  it('reports an unreadable file as a warning rather than throwing', async () => {
    const report = await buildCertificateReport(new Uint8Array([1, 2, 3, 4]));

    expect(report.warnings).toHaveLength(1);
    expect(report.signatures).toEqual([]);
    expect(report.summary.status).toBe('unknown');
  });
});

describe('buildCertificateReport: several signatures', () => {
  it('keeps divergent chains separate rather than merging them', async () => {
    const other = await mintStandardChain();
    const fx = await buildSignedPdfFixture({
      signer: chain.leaf,
      chain: [chain.leaf, chain.intermediate, chain.root, other.intermediate, other.root],
    });
    const report = await buildCertificateReport(fx.bytes);

    expect(report.certificates).toHaveLength(5);
    expect(report.chains).toHaveLength(1);
    expect(report.chains[0].certificateIds).toHaveLength(3);
    // The other chain's certificates are present but unreachable from a signature.
    expect(report.unchainedCertificateIds).toHaveLength(2);
  }, 60000);
});

describe('buildCertificateReport: legacy and certifying signatures', () => {
  it('warns about the deprecated adbe.x509.rsa_sha1 format', async () => {
    const fx = await buildSignedPdfFixture({
      subFilter: 'adbe.x509.rsa_sha1',
      legacyCertificates: [chain.leaf],
    });
    const report = await buildCertificateReport(fx.bytes);

    const check = sigCheck(report, 'sig.legacySubFilter');
    expect(check?.status).toBe('warn');
    expect(check?.detail).toMatch(/deprecated/i);
  }, 30000);

  it('reports a DocMDP certifying signature and what it permits', async () => {
    const fx = await buildSignedPdfFixture({ docMdpLevel: 1 });
    const report = await buildCertificateReport(fx.bytes);

    const check = sigCheck(report, 'sig.docMdp');
    expect(check?.detail).toBe('DocMDP level 1');
    expect(check?.explanation).toMatch(/no changes are permitted/i);
  }, 30000);
});

describe('buildCertificateReport: timestamps and clean verdicts', () => {
  it('reports a timestamp as present but explicitly unverified', async () => {
    const fx = await buildSignedPdfFixture({
      signer: chain.leaf,
      chain: [chain.leaf, chain.intermediate, chain.root],
      timestampToken: true,
    });
    const report = await buildCertificateReport(fx.bytes);

    const check = sigCheck(report, 'sig.timestamp');
    expect(check?.status).toBe('unknown');
    expect(check?.detail).toMatch(/not verified/i);
    expect(check?.explanation).toMatch(/does not verify the timestamp/i);
  }, 30000);

  it('reaches a clean pass when nothing at all is wrong', async () => {
    // A timestamp removes the only warning a well-formed fixture otherwise
    // raises, so this is the one path that reports an unqualified pass.
    const fx = await buildSignedPdfFixture({
      signer: chain.leaf,
      chain: [chain.leaf, chain.intermediate, chain.root],
      timestampToken: true,
    });
    const report = await buildCertificateReport(fx.bytes);

    expect(report.summary.counts.fail).toBe(0);
    expect(report.summary.counts.warn).toBe(0);
    expect(report.summary.status).toBe('pass');
    expect(report.summary.headline).toMatch(/Trust was not evaluated/i);
  }, 30000);

  it('cannot check the document when the signature states no digest', async () => {
    const fx = await buildSignedPdfFixture({ omitMessageDigest: true });
    const report = await buildCertificateReport(fx.bytes);

    const check = sigCheck(report, 'sig.messageDigest');
    expect(check?.status).toBe('unknown');
    expect(check?.detail).toMatch(/states no message digest/i);
    // Reported as unknown, never quietly as a pass.
    expect(check?.status).not.toBe('pass');
  }, 30000);
});

describe('collectAllChecks: one source of truth for the counted checks', () => {
  it('accounts for every check the summary counts, including per-certificate ones', async () => {
    const nearExpiryLeaf = await mint({
      commonName: 'Jane Doe (near expiry)',
      organization: 'PDF Seal Test',
      issuer: chain.intermediate,
      notAfterOffsetMs: 86400000 * 15,
    });
    const fx = await buildSignedPdfFixture({
      signer: nearExpiryLeaf,
      chain: [nearExpiryLeaf, chain.intermediate, chain.root],
    });
    const report = await buildCertificateReport(fx.bytes);

    // This is the bug's exact shape: a warn that lives on a certificate
    // (cert.validity.window, "Expires in N days") must be one of the checks
    // the count counts.
    const leafReportCert = report.certificates.find((c) => c.subject.commonName === 'Jane Doe (near expiry)');
    const expiryCheck = leafReportCert?.checks.find((c) => c.id === 'cert.validity.window');
    expect(expiryCheck?.status).toBe('warn');

    const all = collectAllChecks(report);
    for (const status of ['pass', 'warn', 'fail', 'unknown'] as const) {
      expect(all.filter((c) => c.status === status).length).toBe(report.summary.counts[status]);
    }

    const expiryInAll = all.find((c) => c.id === 'cert.validity.window' && c.source.certificateId === leafReportCert!.id);
    expect(expiryInAll?.status).toBe('warn');
  }, 30000);

  it('gives every check a non-empty source label, and resolves certificate sources', async () => {
    const all = collectAllChecks(cleanReport);
    expect(all.length).toBeGreaterThan(0);
    for (const check of all) {
      expect(check.source.label.length).toBeGreaterThan(0);
      if (check.source.certificateId) {
        expect(cleanReport.certificates.some((c) => c.id === check.source.certificateId)).toBe(true);
      }
    }
  });
});

describe('buildCertificateReport: very large certificate sets', () => {
  it('caps the list and says so rather than returning everything', async () => {
    const extras = [];
    for (let i = 0; i < 101; i++) {
      extras.push(await mint({ commonName: `Filler CA ${i}`, isCa: true }));
    }
    const fx = await buildSignedPdfFixture({
      signer: chain.leaf,
      chain: [chain.leaf, ...extras],
      slotBytes: 120000,
    });
    const report = await buildCertificateReport(fx.bytes);

    expect(report.truncated).toBe(true);
    expect(report.certificates).toHaveLength(100);
    expect(report.warnings.join(' ')).toMatch(/only the first 100 are listed/i);
  }, 120000);
});
