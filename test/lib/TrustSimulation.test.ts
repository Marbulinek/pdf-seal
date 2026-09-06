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
    const rootSignedByGrand = await mint({
      // Must match mintStandardChain()'s root DN exactly, since the
      // intermediate below was minted naming that DN as its issuer.
      commonName: 'PDF Seal Test Root CA',
      organization: 'PDF Seal Test',
      country: 'CZ',
      isCa: true,
      pathLen: 2,
      issuer: grandRoot,
    });

    const certs = [
      parseCertificate(standard.leaf.der),
      parseCertificate(standard.intermediate.der),
      parseCertificate(rootSignedByGrand.der),
    ];
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
    expect(result.detail).toMatch(/no certificate/i);
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
