import { check, makeCert, makeChain, makeReport, makeSignature } from '../../testing/fixtures';
import {
  availableOperations,
  buildSummaryMarkdown,
  byteMapOf,
  certExtensionRows,
  certOverviewSections,
  certSafeFilename,
  certStatusOf,
  certUsedBy,
  certValidityBar,
  certValidityState,
  certWorstStatus,
  chainNodes,
  checkMatchesFilterText,
  collectAllChecks,
  flatCertNodes,
  signatureEvidenceRows,
  statusCounts,
  trustFacts,
  validityTimeline,
} from './certificates-model';

describe('certificates model', () => {
  const report = makeReport();
  const byId = (id: string) => report.certificates.find((c) => c.id === id) ?? null;

  it('ranks statuses worst-first', () => {
    expect(certWorstStatus(['pass', 'warn', 'fail'])).toBe('fail');
    expect(certWorstStatus(['pass', 'unknown'])).toBe('unknown');
    expect(certWorstStatus([])).toBe('unknown');
    expect(certStatusOf(makeCert('x', { checks: [check('a', 'pass'), check('b', 'warn')] }))).toBe('warn');
    expect(statusCounts([check('a', 'pass'), check('b', 'fail'), check('c', 'pass')])).toEqual([
      { status: 'fail', count: 1 },
      { status: 'pass', count: 2 },
    ]);
  });

  it('collects every check with its source, in report order', () => {
    const all = collectAllChecks(report);
    expect(all[0].source).toMatchObject({ kind: 'signature', signatureFieldName: 'Sig1' });
    expect(all.at(-1)?.source).toMatchObject({ kind: 'certificate', certificateId: 'ca' });
    expect(all.filter((c) => checkMatchesFilterText(c, 'digest'))).toHaveLength(1);
    expect(all.filter((c) => checkMatchesFilterText(c, 'chain'))).toHaveLength(1);
  });

  it('writes a markdown summary of failing and warning checks', () => {
    const md = buildSummaryMarkdown(report, byId);
    expect(md).toContain('# Certificate report — One warning');
    expect(md).toContain('**WARN** CMS — Signature: Sig1');
  });

  it('draws the chain root-first with the signature at the bottom', () => {
    const nodes = chainNodes(makeChain({ missingIssuerDn: 'CN=Missing Root, O=X' }), makeSignature(), byId);
    expect(nodes.map((n) => n.name)).toEqual(['Missing Root', 'ca', 'leaf', 'Alex Morgan']);
    // A missing issuer is usually the root, kept in the verifier's trust store: unknown, not a warning.
    expect(nodes[0]).toMatchObject({ missing: true, isRoot: true, depth: 0, status: 'unknown' });
    expect(nodes[3]).toMatchObject({ signatureField: 'Sig1', role: 'Signature — field Sig1', detail: 'Page 1' });
    expect(flatCertNodes([makeCert('x')], () => 'detail')[0]).toMatchObject({ depth: 0, certId: 'x', detail: 'detail' });
  });

  it('maps the signed byte ranges and slot occupancy', () => {
    const map = byteMapOf(makeSignature({ cmsSlot: { byteRange: [0, 100, 200, 300], capacityBytes: 1000, derLength: 250, headroomBytes: 750, coversWholeFile: false, trailingBytes: 20 } }));
    expect(map?.segments.map((s) => s.cls)).toEqual(['is-signed', 'is-gap', 'is-signed', 'is-trailing']);
    expect(map?.occupiedPct).toBe(25);
    expect(map?.trailingNote).toContain('last 20 bytes');
    expect(byteMapOf(makeSignature({ cmsSlot: null }))).toBeNull();
  });

  it('lays out the validity timeline with a claimed-time marker', () => {
    const t = validityTimeline(makeChain(), makeSignature(), byId, new Date('2024-06-01T00:00:00Z'));
    expect(t?.rows).toHaveLength(2);
    expect(t?.markers.map((m) => m.cls)).toEqual(['is-claimed']);
    expect(t?.hasTimestamp).toBe(false);
    expect(validityTimeline(makeChain({ certificateIds: [] }), makeSignature(), byId)).toBeNull();
  });

  it('lists the signature evidence, offering a later-revisions slot', () => {
    const rows = signatureEvidenceRows(makeSignature());
    expect(rows.map((r) => r.label)).toEqual(['Signed bytes', 'Digest', 'CMS signature', 'Later revisions', 'Trust', 'Revocation']);
    expect(rows[3].slot).toEqual({ from: 1, to: 2 });
    expect(rows[4]).toMatchObject({ text: 'Not evaluated — no trust store', status: 'unknown' });
  });

  it('shows trust, timestamp and later changes as their own evidence rows', () => {
    const sig = makeSignature({
      checks: [
        check('sig.laterChanges', 'unknown', 'Later changes'),
        check('sig.timestamp', 'unknown', 'Timestamp', 'trust'),
      ],
    });
    const trusted = signatureEvidenceRows(sig, { status: 'pass', detail: '', matchedRootSubject: 'CN=Root', extendedWithIssuer: false });
    expect(trusted.find((r) => r.label === 'Later revisions')).toMatchObject({ text: 'Later changes detail', status: 'unknown' });
    expect(trusted.find((r) => r.label === 'Trust')).toMatchObject({ text: 'Trusted by your bundle (simulated)', status: 'pass' });
    expect(trusted.find((r) => r.label === 'Timestamp')).toMatchObject({ text: 'Timestamp detail', status: 'unknown' });

    const untrusted = signatureEvidenceRows(sig, { status: 'fail', detail: '', matchedRootSubject: null, extendedWithIssuer: false });
    expect(untrusted.find((r) => r.label === 'Trust')).toMatchObject({ status: 'fail' });
  });

  it('keeps trust, timestamp and revocation facts beside the verdict', () => {
    const r = makeReport({ signatures: [makeSignature(), makeSignature({ fieldName: 'Sig2', hasTimestampToken: true })] });
    expect(trustFacts(r, null)).toEqual([
      { label: 'Trust', value: 'Not evaluated' },
      { label: 'Timestamp', value: '1 none, 1 not verified' },
      { label: 'Revocation', value: 'Not checked' },
    ]);
    const verified = makeReport({ signatures: [makeSignature({ hasTimestampToken: true, timestampVerified: true })] });
    expect(trustFacts(verified, null)[1].value).toBe('Verified');
    const invalid = makeReport({ signatures: [makeSignature({ hasTimestampToken: true, timestampVerified: false })] });
    expect(trustFacts(invalid, null)[1].value).toBe('Invalid');
    const chainId = r.chains[0].id;
    const pass = { status: 'pass' as const, detail: '', matchedRootSubject: null, extendedWithIssuer: false };
    expect(trustFacts(r, { [chainId]: pass })[0].value).toBe('Trusted (simulated)');
    expect(trustFacts(r, { [chainId]: { ...pass, status: 'fail' } })[0].value).toBe('Not trusted (simulated)');

    const withDocTimestamp = makeReport({ signatures: [makeSignature(), makeSignature({ fieldName: 'DTS', isDocumentTimestamp: true })] });
    expect(trustFacts(withDocTimestamp, null)[1].value).toBe('None · 1 document timestamp');
  });

  it('offers only the modify operations a signature supports', () => {
    const ca = makeCert('ca', { extensions: { ...makeCert('ca').extensions, basicConstraints: { critical: true, isCa: true, pathLenConstraint: null } } });
    const ops = availableOperations(makeSignature(), (id) => (id === 'ca' ? ca : byId(id)));
    expect(ops.map((o) => [o.op, o.available])).toEqual([
      ['remove-certificate', true],
      ['remove-intermediates', true],
      ['replace-signer', true],
      ['replace-chain', true],
    ]);
    const lone = availableOperations(makeSignature({ certificateIds: ['leaf'], signerCertificateId: null }), byId);
    expect(lone.every((o) => !o.available)).toBe(true);
  });

  it('describes a certificate for the sheet', () => {
    const cert = makeCert('Leaf Cert', { daysUntilExpiry: 10 });
    expect(certValidityState(cert)).toBe('Valid — 10 days left');
    expect(certValidityState(makeCert('x', { isExpired: true }))).toBe('Expired');
    expect(certValidityBar(cert, Date.parse('2030-01-01T00:00:00Z'))).toMatchObject({ percent: 50, tone: 'is-warn' });
    const sections = certOverviewSections(cert);
    expect(sections.map((s) => s.title)).toEqual(['Identity', 'Issuer', 'Validity', 'Serial & fingerprints', 'Public key & signature', 'Found in']);
    expect(sections[3].rows[1]).toMatchObject({ label: 'SHA-256', copy: true, mono: true });
    expect(sections[5].rows[0]).toEqual({ label: 'Signature content', value: 'Field Sig1' });
    expect(certUsedBy(makeCert('ca'), report)).toHaveLength(1);
    expect(certSafeFilename(makeCert('My Cert / 2024'))).toBe('My-Cert-2024');
  });

  it('lists only the extensions present, with the revocation note when CRL/OCSP appear', () => {
    expect(certExtensionRows(makeCert('x')).rows).toEqual([]);
    const ext = certExtensionRows(
      makeCert('x', {
        extensions: {
          ...makeCert('x').extensions,
          keyUsage: { critical: true, usages: ['digitalSignature'], bits: 1 },
          crlDistributionPoints: ['http://crl'],
        },
      }),
    );
    expect(ext.rows.map((r) => [r.name, r.critical])).toEqual([
      ['Key Usage', true],
      ['CRL Distribution Points', false],
    ]);
    expect(ext.revocationNote).toBe(true);
  });
});
