import { describe, it, expect, beforeAll } from 'vitest';
import { parseCertificate } from '../../lib/CertificateModel';
import { buildChain } from '../../lib/CertificateChain';
import { simulateTrust } from '../../lib/TrustSimulation';
import { mint, mintStandardChain, type StandardChain } from './helpers/certificateFactory';

let standard: StandardChain;

beforeAll(async () => {
  standard = await mintStandardChain();
});

function chainCertificates() {
  const certs = [
    parseCertificate(standard.leaf.der),
    parseCertificate(standard.intermediate.der),
    parseCertificate(standard.root.der),
  ];
  return buildChain(certs[0], certs, { id: 'sim' }).certificateIds.map(
    (id) => certs.find((c) => c.id === id)!,
  );
}

describe('simulateTrust', () => {
  it('passes when the embedded root itself is in the bundle', () => {
    const result = simulateTrust(chainCertificates(), [parseCertificate(standard.root.der)]);
    expect(result.status).toBe('pass');
    expect(result.extendedWithIssuer).toBe(false);
    expect(result.matchedRootSubject).toMatch(/Test Root CA/);
  });

  it('passes and extends the chain when a bundle certificate issues the top of the embedded chain', async () => {
    // A "grandparent" that actually signed the embedded root, but was not
    // itself embedded in the document -- the common real-world case of a
    // root bundle covering more than the document carries.
    const grandRoot = await mint({ commonName: 'Grand Root', isCa: true, pathLen: 3 });
    const root = await mint({ commonName: 'Cross-Signed Root', isCa: true, pathLen: 2, issuer: grandRoot });
    const intermediate = await mint({ commonName: 'Cross Issuing CA', isCa: true, pathLen: 0, issuer: root });
    const leaf = await mint({ commonName: 'Cross Signer', issuer: intermediate });

    const certs = [leaf, intermediate, root].map((c) => parseCertificate(c.der));
    const chain = buildChain(certs[0], certs, { id: 'sim' }).certificateIds.map(
      (id) => certs.find((c) => c.id === id)!,
    );

    const result = simulateTrust(chain, [parseCertificate(grandRoot.der)]);
    expect(result.status).toBe('pass');
    expect(result.extendedWithIssuer).toBe(true);
    expect(result.matchedRootSubject).toMatch(/Grand Root/);
  });

  it('fails when nothing in the bundle matches or issues the chain', async () => {
    const unrelated = await mint({ commonName: 'Unrelated CA', isCa: true });
    const result = simulateTrust(chainCertificates(), [parseCertificate(unrelated.der)]);
    expect(result.status).toBe('fail');
    expect(result.matchedRootSubject).toBeNull();
    expect(result.detail).toMatch(/not in your bundle/i);
  });

  it('passes when the user trusts an intermediate rather than the root', () => {
    const result = simulateTrust(chainCertificates(), [parseCertificate(standard.intermediate.der)]);
    expect(result.status).toBe('pass');
    expect(result.extendedWithIssuer).toBe(false);
    expect(result.detail).toMatch(/every link below it verifies/i);
  });

  it('fails a chain with a broken link even when its root is trusted', async () => {
    // Same name as the real issuing CA, different key, itself issued by the
    // real root: the top of the chain is fine, the step below it is not.
    const impostor = await mint({
      commonName: 'PDF Seal Test Signing CA',
      organization: 'PDF Seal Test',
      isCa: true,
      issuer: standard.root,
    });
    const chain = [
      parseCertificate(standard.leaf.der),
      parseCertificate(impostor.der),
      parseCertificate(standard.root.der),
    ];
    const result = simulateTrust(chain, [parseCertificate(standard.root.der)]);
    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/chain is broken between Jane Doe and PDF Seal Test Signing CA/);
  });

  it('names the issuer a short chain needs when the bundle does not supply it', async () => {
    const unrelated = await mint({ commonName: 'Unrelated CA', isCa: true });
    const result = simulateTrust([parseCertificate(standard.leaf.der)], [parseCertificate(unrelated.der)]);
    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/PDF Seal Test Signing CA/);
  });

  it('fails gracefully against an empty bundle', () => {
    const result = simulateTrust(chainCertificates(), []);
    expect(result.status).toBe('fail');
  });

  it('fails gracefully when given an empty chain', () => {
    const result = simulateTrust([], [parseCertificate(standard.root.der)]);
    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/no certificates to evaluate/i);
  });

  it('never computes or exposes a revocation verdict', () => {
    const result = simulateTrust(chainCertificates(), [parseCertificate(standard.root.der)]);
    expect(result).not.toHaveProperty('revocation');
    expect(Object.keys(result).sort()).toEqual(
      ['detail', 'extendedWithIssuer', 'matchedRootSubject', 'status'].sort(),
    );
  });
});
