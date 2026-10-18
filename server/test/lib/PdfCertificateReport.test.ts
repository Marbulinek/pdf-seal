import { describe, it, expect, beforeAll } from 'vitest';
import { buildCertificateReport, collectAllChecks, signatureVerdict } from '../../lib/PdfCertificateReport';
import type { ValidationResult } from '../../lib/CertificateModel';
import PdfSignatureTool from '../../lib/PdfSignatureTool';
import { TRUST_NOTE } from '../../lib/CertificateChain';
import { mint, mintStandardChain, type StandardChain } from './helpers/certificateFactory';
import { buildSignedPdfFixture, buildUnsignedPdfFixture } from './helpers/pdfSigner';
import { appendClassicIncrement, appendIncrement, nextObjectNumber } from './helpers/classicIncrement';

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
  }, 30000);
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

  it('says the signing time is only a claim when nothing timestamps it, without judging the signature', () => {
    const check = sigCheck(cleanReport, 'sig.timestamp');
    expect(check?.status).toBe('unknown');
    expect(check?.axis).toBe('trust');
    expect(check?.explanation).toMatch(/signer’s own claim/i);
  });

  it('is green without a timestamp: the signature is intact, and trust is reported apart', () => {
    expect(cleanReport.signatures[0].status).toBe('pass');
    expect(cleanReport.summary.status).toBe('pass');
    expect(cleanReport.summary.headline).toMatch(/Trust was not evaluated/i);
    // Green never implies trust.
    expect(cleanReport.chains[0].checks.find((c) => c.id === 'chain.trust')?.status).toBe('unknown');
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
      expect(['signature', 'trust', 'diagnostic']).toContain(check.axis);
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
  it('stays green when the root is not embedded', async () => {
    const fx = await buildSignedPdfFixture({
      signer: chain.leaf,
      chain: [chain.leaf, chain.intermediate],
    });
    const report = await buildCertificateReport(fx.bytes);

    expect(report.chains[0].complete).toBe(false);
    expect(report.chains[0].checks.find((c) => c.id === 'chain.root')?.status).toBe('unknown');
    // Where the chain stops is a trust question; it does not colour the verdict.
    expect(report.summary.status).toBe('pass');
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
    const check = report.chains[0].checks.find((c) => c.id === 'chain.root');
    expect(check?.status).toBe('unknown');
    expect(check?.detail).toContain('PDF Seal Test Signing CA');

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
  }, 30000);
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
  it('reports an unreadable timestamp token as invalid, beside the verdict', async () => {
    const fx = await buildSignedPdfFixture({
      signer: chain.leaf,
      chain: [chain.leaf, chain.intermediate, chain.root],
      timestampToken: true,
    });
    const report = await buildCertificateReport(fx.bytes);

    const check = sigCheck(report, 'sig.timestamp');
    expect(check).toMatchObject({ status: 'fail', axis: 'trust' });
    expect(check?.detail).toMatch(/could not be read/i);
    expect(report.signatures[0].timestampVerified).toBe(false);
    // The signature itself is no worse for it.
    expect(report.signatures[0].status).toBe('pass');
  }, 30000);

  it('decodes the timestamp token\'s own genTime, independent of the signer\'s claimed time', async () => {
    const genTime = new Date('2023-06-15T12:00:00.000Z');
    const fx = await buildSignedPdfFixture({
      signer: chain.leaf,
      chain: [chain.leaf, chain.intermediate, chain.root],
      timestampGenTime: genTime,
    });
    const report = await buildCertificateReport(fx.bytes);

    expect(report.signatures[0].timestampTime).toBe(genTime.toISOString());
  }, 30000);

  it('leaves timestampTime null when there is no timestamp token, or it cannot be read', async () => {
    const untimestamped = await buildSignedPdfFixture({
      signer: chain.leaf,
      chain: [chain.leaf, chain.intermediate, chain.root],
    });
    expect((await buildCertificateReport(untimestamped.bytes)).signatures[0].timestampTime).toBeNull();

    const placeholder = await buildSignedPdfFixture({
      signer: chain.leaf,
      chain: [chain.leaf, chain.intermediate, chain.root],
      timestampToken: true,
    });
    expect((await buildCertificateReport(placeholder.bytes)).signatures[0].timestampTime).toBeNull();
  }, 30000);

  it('verifies a genuine timestamp token against the TSA certificate it carries', async () => {
    const tsa = await mint({ commonName: 'PDF Seal Test TSA', issuer: chain.intermediate, eku: ['1.3.6.1.5.5.7.3.8'] });
    const fx = await buildSignedPdfFixture({
      signer: chain.leaf,
      chain: [chain.leaf, chain.intermediate, chain.root],
      timestampAuthority: tsa,
    });
    const report = await buildCertificateReport(fx.bytes);

    const check = sigCheck(report, 'sig.timestamp');
    expect(check).toMatchObject({ status: 'pass', axis: 'trust' });
    expect(check?.detail).toMatch(/^Verified: issued by PDF Seal Test TSA/);
    expect(check?.explanation).toMatch(/not evaluated/i);
    expect(report.signatures[0].timestampVerified).toBe(true);
    expect(report.signatures[0].timestampTime).not.toBeNull();
    // The chain is then measured at the verified time, and says so.
    const atSigning = report.chains[0].checks.find((c) => c.id === 'chain.validityAtSigningTime');
    expect(atSigning?.status).toBe('pass');
    expect(atSigning?.explanation).toMatch(/whose token verified/i);

    expect(report.summary.counts.fail).toBe(0);
    expect(report.summary.counts.warn).toBe(0);
    expect(report.summary.status).toBe('pass');
    expect(report.summary.headline).toMatch(/Trust was not evaluated/i);
  }, 30000);

  it('fails a timestamp token that timestamps something other than this signature', async () => {
    const tsa = await mint({ commonName: 'PDF Seal Test TSA', issuer: chain.intermediate, eku: ['1.3.6.1.5.5.7.3.8'] });
    const fx = await buildSignedPdfFixture({
      signer: chain.leaf,
      chain: [chain.leaf, chain.intermediate, chain.root],
      timestampAuthority: tsa,
      timestampForeignImprint: true,
    });
    const report = await buildCertificateReport(fx.bytes);

    const check = sigCheck(report, 'sig.timestamp');
    expect(check?.status).toBe('fail');
    expect(check?.explanation).toMatch(/message imprint does not match/i);
    expect(report.signatures[0].timestampVerified).toBe(false);
    // An invalid timestamp is not evidence of time: the claim is used instead.
    const atSigning = report.chains[0].checks.find((c) => c.id === 'chain.validityAtSigningTime');
    expect(atSigning?.explanation).toMatch(/claimed by the signer/i);
    expect(report.signatures[0].status).toBe('pass');
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

describe('buildCertificateReport: revision coverage', () => {
  it('maps the signed bytes to a revision and flags later revisions without a verdict', async () => {
    const fx = await buildSignedPdfFixture({ docMdpLevel: 2 });
    const clean = await buildCertificateReport(fx.bytes);
    expect(clean.signatures[0].revisionCoverage).toEqual({ coveredRevision: 1, revisionCount: 1 });
    expect(sigCheck(clean, 'sig.docMdp')?.status).toBe('pass');

    const grown = appendClassicIncrement(Buffer.from(fx.bytes), 'Later edit');
    const report = await buildCertificateReport(new Uint8Array(grown));

    expect(report.signatures[0].revisionCoverage).toEqual({ coveredRevision: 1, revisionCount: 2 });
    // Covering an earlier revision cleanly is not a coverage problem...
    const coverage = sigCheck(report, 'sig.byteRangeCoverage');
    expect(coverage?.status).toBe('pass');
    expect(coverage?.detail).toMatch(/revision 1 of 2/);
    expect(sigCheck(report, 'sig.messageDigest')?.status).toBe('pass');
    expect(sigCheck(report, 'sig.cryptographic')?.status).toBe('pass');
    // ...and what came after is reported, never passed.
    const later = sigCheck(report, 'sig.laterChanges');
    expect(later?.status).toBe('unknown');
    expect(later?.detail).toBe('1 later revision: metadata changed');
    expect(later?.explanation).toMatch(/not whether it was permitted/i);
    expect(sigCheck(report, 'sig.docMdp')?.status).toBe('pass');
    expect(sigCheck(report, 'sig.docMdp')?.explanation).toMatch(/not check those later changes/i);
    expect(report.summary.status).toBe('pass');
  }, 30000);

  it('still maps coverage when bytes trail the final revision', async () => {
    const fx = await buildSignedPdfFixture({ appendTrailingBytes: 48 });
    const report = await buildCertificateReport(fx.bytes);
    expect(report.signatures[0].revisionCoverage.coveredRevision).toBe(1);
    expect(report.signatures[0].revisionCoverage.revisionCount).toBe(1);
  }, 30000);
});

/** Shift /ByteRange's first range to start at `a`, keeping every offset after it. */
function startByteRangeAt(bytes: Uint8Array, a: number): Uint8Array {
  const out = Buffer.from(bytes);
  const text = out.toString('latin1');
  const marker = /\/ByteRange\s*\[([^\]]*)\]/.exec(text)!;
  const [, b, c, d] = marker[1].trim().split(/\s+/).map(Number);
  const replacement = ` ${[a, b - a, c, d].join(' ')} `.padEnd(marker[1].length, ' ');
  out.write(replacement, marker.index + marker[0].indexOf('[') + 1, 'latin1');
  return new Uint8Array(out);
}

describe('signature verdicts', () => {
  const check = (id: string, status: ValidationResult['status'], axis: ValidationResult['axis'] = 'signature') =>
    ({ id, label: id, status, detail: '', explanation: '', axis }) as ValidationResult;
  const core = [
    'sig.contentsSlot',
    'sig.signerIdentified',
    'sig.messageDigest',
    'sig.cryptographic',
    'chain.validityAtSigningTime',
  ].map((id) => check(id, 'pass'));

  it('passes only when every core check passes', () => {
    expect(signatureVerdict(core)).toBe('pass');
    expect(signatureVerdict(core.filter((c) => c.id !== 'sig.cryptographic'))).toBe('unknown');
    expect(signatureVerdict([...core.slice(1), check('sig.contentsSlot', 'unknown')])).toBe('unknown');
  });

  it('lets a failure anywhere on the signature axis win', () => {
    expect(signatureVerdict([...core, check('link.cryptographic', 'fail')])).toBe('fail');
  });

  it('warns only once the core holds', () => {
    expect(signatureVerdict([...core, check('cert.eku', 'warn')])).toBe('warn');
    expect(signatureVerdict([...core.slice(1), check('cert.eku', 'warn')])).toBe('unknown');
  });

  it('ignores trust and diagnostic checks, and non-core unknowns', () => {
    expect(
      signatureVerdict([
        ...core,
        check('chain.trust', 'unknown', 'trust'),
        check('cert.selfSigned', 'warn', 'trust'),
        check('cert.validity.window', 'fail', 'diagnostic'),
        check('link.akiSki', 'unknown'),
      ]),
    ).toBe('pass');
  });
});

describe('buildCertificateReport: what the verdict is and is not about', () => {
  it('ignores certificates no signature relies on, however broken', async () => {
    const strayExpired = await mint({
      commonName: 'Stray OCSP Responder',
      issuer: chain.intermediate,
      notBeforeOffsetMs: -86400000 * 30,
      notAfterOffsetMs: -86400000,
    });
    const fx = await buildSignedPdfFixture({
      signer: chain.leaf,
      chain: [chain.leaf, chain.intermediate, chain.root],
      dssCertificates: [strayExpired],
    });
    const report = await buildCertificateReport(fx.bytes);

    const stray = report.certificates.find((c) => c.subject.commonName === 'Stray OCSP Responder')!;
    expect(report.unchainedCertificateIds).toContain(stray.id);
    const window = stray.checks.find((c) => c.id === 'cert.validity.window');
    expect(window?.status).toBe('fail');
    expect(window?.axis).toBe('diagnostic');
    // Still counted, so the list adds up -- just not judged.
    expect(report.summary.counts.fail).toBeGreaterThan(0);
    expect(report.summary.status).toBe('pass');
  }, 30000);

  it('fails a signature whose own chain does not hold, even though its CMS verifies', async () => {
    // Same name as the real issuing CA, different key: the names line up and
    // the issuer signature on the leaf does not.
    const impostor = await mint({
      commonName: 'PDF Seal Test Signing CA',
      organization: 'PDF Seal Test',
      isCa: true,
      issuer: chain.root,
    });
    const fx = await buildSignedPdfFixture({
      signer: chain.leaf,
      chain: [chain.leaf, impostor, chain.root],
    });
    const report = await buildCertificateReport(fx.bytes);

    expect(sigCheck(report, 'sig.cryptographic')?.status).toBe('pass');
    expect(report.chains[0].links[0].checks.find((c) => c.id === 'link.cryptographic')?.status).toBe('fail');
    expect(report.signatures[0].status).toBe('fail');
    expect(report.summary.status).toBe('fail');
  }, 30000);

  it('warns about later revisions after a certification that permits no changes', async () => {
    const fx = await buildSignedPdfFixture({ docMdpLevel: 1 });
    const grown = appendClassicIncrement(Buffer.from(fx.bytes), 'Later edit');
    const report = await buildCertificateReport(new Uint8Array(grown));

    expect(sigCheck(report, 'sig.byteRangeCoverage')?.status).toBe('pass');
    const later = sigCheck(report, 'sig.laterChanges');
    expect(later?.status).toBe('warn');
    expect(later?.detail).toMatch(/no-changes certification/i);
    expect(report.summary.status).toBe('warn');
  }, 30000);

  it('warns when a later revision changes what the page shows', async () => {
    const fx = await buildSignedPdfFixture({});
    const signed = Buffer.from(fx.bytes);
    // Rewrite the page in a new revision so it draws a new content stream.
    const text = signed.toString('latin1');
    const page = /(\d+) 0 obj\n(<<\n\/Type \/Page\n[\s\S]*?)\nendobj/.exec(text)!;
    const contentNum = nextObjectNumber(signed);
    const pageBody = /\/Contents\s+\d+\s+0\s+R/.test(page[2])
      ? page[2].replace(/\/Contents\s+\d+\s+0\s+R/, `/Contents ${contentNum} 0 R`)
      : page[2].replace('<<', `<< /Contents ${contentNum} 0 R`);
    const stream = 'BT /F1 24 Tf 72 720 Td (Paid in full) Tj ET';
    const edited = appendIncrement(signed, [
      { body: `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream` },
      { num: Number(page[1]), body: pageBody },
    ]);
    const report = await buildCertificateReport(new Uint8Array(edited));

    expect(sigCheck(report, 'sig.messageDigest')?.status).toBe('pass');
    const later = sigCheck(report, 'sig.laterChanges');
    expect(later?.status).toBe('warn');
    expect(later?.detail).toMatch(/change page content: 1 page content stream changed/);
    expect(later?.explanation).toMatch(/not what was signed/i);
    expect(report.summary.status).toBe('warn');
  }, 30000);

  it('reports no later changes when nothing follows the signature', () => {
    expect(sigCheck(cleanReport, 'sig.laterChanges')).toBeUndefined();
  });

  it('still warns about bytes after the signature that are not a complete revision', async () => {
    const fx = await buildSignedPdfFixture({ appendTrailingBytes: 48 });
    const report = await buildCertificateReport(fx.bytes);
    expect(sigCheck(report, 'sig.byteRangeCoverage')?.status).toBe('warn');
    expect(sigCheck(report, 'sig.laterChanges')).toBeUndefined();
    expect(report.summary.status).toBe('warn');
  }, 30000);

  it('fails a signature whose byte ranges do not start at the beginning of the file', async () => {
    const fx = await buildSignedPdfFixture({});
    const report = await buildCertificateReport(startByteRangeAt(fx.bytes, 5));

    const coverage = sigCheck(report, 'sig.byteRangeCoverage');
    expect(coverage?.status).toBe('fail');
    expect(coverage?.detail).toMatch(/first 5 byte/);
    expect(report.summary.status).toBe('fail');
  }, 30000);
});

describe('buildCertificateReport: signatures that used to read as red', () => {
  const DAY = 86400000;

  async function historicalChain(leafValidTo: number) {
    const root = await mint({ commonName: 'Old Root', isCa: true, notBeforeOffsetMs: -DAY * 2000, notAfterOffsetMs: DAY * 2000 });
    const leaf = await mint({
      commonName: 'Former Employee',
      issuer: root,
      notBeforeOffsetMs: -DAY * 400,
      notAfterOffsetMs: leafValidTo,
    });
    return { root, leaf };
  }

  it('stays green when the certificate expired after the claimed signing time', async () => {
    const { root, leaf } = await historicalChain(-DAY * 10);
    const fx = await buildSignedPdfFixture({
      signer: leaf,
      chain: [leaf, root],
      signingTime: new Date(Date.now() - DAY * 200),
    });
    const report = await buildCertificateReport(fx.bytes);

    const leafCert = report.certificates.find((c) => c.subject.commonName === 'Former Employee')!;
    expect(leafCert.checks.find((c) => c.id === 'cert.validity.window')?.status).toBe('fail');
    expect(report.chains[0].checks.find((c) => c.id === 'chain.validityAtSigningTime')?.status).toBe('pass');
    expect(report.signatures[0].status).toBe('pass');
    // Nothing proves the signing time: that stays visible beside the verdict.
    expect(sigCheck(report, 'sig.timestamp')?.detail).toBe('No timestamp');
  }, 30000);

  it('measures validity at a verified timestamp rather than at the signer’s claim', async () => {
    const { root, leaf } = await historicalChain(-DAY * 10);
    const tsa = await mint({ commonName: 'Long-Lived TSA', issuer: root, notBeforeOffsetMs: -DAY * 1000, eku: ['1.3.6.1.5.5.7.3.8'] });
    const fx = await buildSignedPdfFixture({
      signer: leaf,
      chain: [leaf, root],
      // The signer claims "now", after its certificate expired; the timestamp
      // proves the signature existed 200 days ago, when it was still valid.
      signingTime: new Date(),
      timestampAuthority: tsa,
      timestampGenTime: new Date(Date.now() - DAY * 200),
    });
    const report = await buildCertificateReport(fx.bytes);

    expect(sigCheck(report, 'sig.timestamp')?.status).toBe('pass');
    expect(report.chains[0].checks.find((c) => c.id === 'chain.validityAtSigningTime')?.status).toBe('pass');
    expect(report.signatures[0].status).toBe('pass');
  }, 30000);

  it('fails when the claimed signing time falls after the certificate expired', async () => {
    const { root, leaf } = await historicalChain(-DAY * 10);
    const fx = await buildSignedPdfFixture({ signer: leaf, chain: [leaf, root], signingTime: new Date() });
    const report = await buildCertificateReport(fx.bytes);

    const check = report.chains[0].checks.find((c) => c.id === 'chain.validityAtSigningTime');
    expect(check?.status).toBe('fail');
    expect(check?.detail).toContain('Former Employee');
    expect(report.summary.status).toBe('fail');
  }, 30000);

  it('holds a self-signed signer to signer rules and reports the missing trust beside the verdict', async () => {
    const selfSigned = await mint({ commonName: 'Developer Test Key' });
    const fx = await buildSignedPdfFixture({ signer: selfSigned, chain: [selfSigned] });
    const report = await buildCertificateReport(fx.bytes);

    const cert = report.certificates[0];
    expect(cert.role).toBe('signer');
    expect(cert.checks.find((c) => c.id === 'cert.selfSigned')).toMatchObject({ status: 'warn', axis: 'trust' });
    expect(report.signatures[0].status).toBe('pass');
  }, 30000);
});

describe('buildCertificateReport: document timestamps', () => {
  let tsa: Awaited<ReturnType<typeof mint>>;
  beforeAll(async () => {
    tsa = await mint({
      commonName: 'PDF Seal Test TSA',
      organization: 'PDF Seal Test',
      issuer: chain.intermediate,
      eku: ['1.3.6.1.5.5.7.3.8'],
    });
  }, 30000);

  it('checks the document against the timestamp’s message imprint', async () => {
    const fx = await buildSignedPdfFixture({
      signer: tsa,
      chain: [tsa, chain.intermediate, chain.root],
      documentTimestamp: true,
    });
    const report = await buildCertificateReport(fx.bytes);
    const sig = report.signatures[0];

    expect(sig.isDocumentTimestamp).toBe(true);
    expect(sig.timestampTime).not.toBeNull();
    expect(sigCheck(report, 'sig.messageDigest')?.status).toBe('pass');
    expect(sigCheck(report, 'sig.cryptographic')?.status).toBe('pass');
    // It is the timestamp; it does not need one of its own.
    expect(sigCheck(report, 'sig.timestamp')).toBeUndefined();
    const tsaCert = report.certificates.find((c) => c.subject.commonName === 'PDF Seal Test TSA')!;
    expect(tsaCert.checks.find((c) => c.id === 'cert.eku')?.status).toBe('pass');
    // Its own genTime is the time the chain is checked against.
    expect(report.chains[0].checks.find((c) => c.id === 'chain.validityAtSigningTime')?.status).toBe('pass');
    expect(sig.status).toBe('pass');
    expect(report.summary.status).toBe('pass');
  }, 30000);

  it('fails a document timestamp when the covered bytes changed', async () => {
    const fx = await buildSignedPdfFixture({
      signer: tsa,
      chain: [tsa, chain.intermediate, chain.root],
      documentTimestamp: true,
      tamperWithContent: true,
    });
    const report = await buildCertificateReport(fx.bytes);

    expect(sigCheck(report, 'sig.messageDigest')?.status).toBe('fail');
    expect(sigCheck(report, 'sig.cryptographic')?.detail).toMatch(/document changed after signing/i);
    expect(report.summary.status).toBe('fail');
  }, 30000);
});

describe('buildCertificateReport: finding the signer', () => {
  it('verifies a signature whose signer certificate is only in /DSS', async () => {
    const fx = await buildSignedPdfFixture({
      signer: chain.leaf,
      chain: [chain.intermediate, chain.root],
      dssCertificates: [chain.leaf],
    });
    const report = await buildCertificateReport(fx.bytes);

    const identified = sigCheck(report, 'sig.signerIdentified');
    expect(identified?.status).toBe('pass');
    expect(identified?.explanation).toMatch(/document security store/i);
    expect(sigCheck(report, 'sig.cryptographic')?.status).toBe('pass');
    expect(report.chains[0].certificateIds).toHaveLength(3);
    expect(report.signatures[0].status).toBe('pass');
  }, 30000);

  it('matches the signer by issuer and serial number, not by serial number alone', async () => {
    const otherCa = await mint({ commonName: 'Other Issuing CA', isCa: true });
    const decoy = await mint({ commonName: 'Same Serial, Other Issuer', issuer: otherCa, serialNumber: 0x7777 });
    const signer = await mint({
      commonName: 'Real Signer',
      organization: 'PDF Seal Test',
      issuer: chain.intermediate,
      serialNumber: 0x7777,
    });
    const fx = await buildSignedPdfFixture({
      signer,
      chain: [decoy, signer, chain.intermediate, chain.root],
    });
    const report = await buildCertificateReport(fx.bytes);

    const signerCert = report.certificates.find((c) => c.id === report.signatures[0].signerCertificateId);
    expect(signerCert?.subject.commonName).toBe('Real Signer');
    expect(sigCheck(report, 'sig.cryptographic')?.status).toBe('pass');
  }, 30000);
});
