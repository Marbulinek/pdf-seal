import { describe, it, expect, beforeAll } from 'vitest';
import { parseCertificate, type ParsedCertificate } from '../../lib/CertificateModel';
import {
  buildChain,
  buildChains,
  checkCertificate,
  checkLink,
  rollUp,
  worstStatus,
  TRUST_NOTE,
} from '../../lib/CertificateChain';
import { mint, mintStandardChain, type StandardChain } from './helpers/certificateFactory';

let chain: StandardChain;
let leaf: ParsedCertificate;
let intermediate: ParsedCertificate;
let root: ParsedCertificate;

/** Fresh copies each time -- buildChain assigns roles and checks in place. */
function pool(): ParsedCertificate[] {
  return [
    parseCertificate(chain.leaf.der),
    parseCertificate(chain.intermediate.der),
    parseCertificate(chain.root.der),
  ];
}

function find(checks: { id: string }[], id: string) {
  return checks.find((c) => c.id === id);
}

beforeAll(async () => {
  chain = await mintStandardChain();
  leaf = parseCertificate(chain.leaf.der);
  intermediate = parseCertificate(chain.intermediate.der);
  root = parseCertificate(chain.root.der);
}, 30000);

describe('worstStatus / rollUp', () => {
  it('lets the worst status win so a summary never reads better than its parts', () => {
    expect(worstStatus(['pass', 'warn', 'fail'])).toBe('fail');
    expect(worstStatus(['pass', 'warn', 'unknown'])).toBe('warn');
    expect(worstStatus(['pass', 'unknown'])).toBe('unknown');
    expect(worstStatus(['pass', 'pass'])).toBe('pass');
  });

  it('reports nothing-checked as unknown rather than as a pass', () => {
    expect(worstStatus([])).toBe('unknown');
    expect(rollUp([])).toBe('unknown');
  });
});

describe('buildChain', () => {
  it('walks leaf -> intermediate -> root and assigns each its role', () => {
    const certs = pool();
    const built = buildChain(certs[0], certs, { id: 'c1' });

    expect(built.certificateIds).toEqual([certs[0].id, certs[1].id, certs[2].id]);
    expect(certs.map((c) => c.role)).toEqual(['signer', 'intermediate', 'root']);
    expect(built.complete).toBe(true);
    expect(built.brokenAtIndex).toBeNull();
    expect(built.missingIssuerDn).toBeNull();
    expect(built.links).toHaveLength(2);
  });

  it('stops and names the issuer it needs when an intermediate is absent', () => {
    const certs = pool().filter((c) => c.subject.commonName !== 'PDF Seal Test Signing CA');
    const built = buildChain(certs[0], certs, { id: 'c1' });

    expect(built.certificateIds).toHaveLength(1);
    expect(built.complete).toBe(false);
    expect(built.brokenAtIndex).toBe(0);
    expect(built.missingIssuerDn).toContain('PDF Seal Test Signing CA');

    const check = find(built.checks, 'chain.missingIntermediate');
    expect(check?.status).toBe('warn');
    expect(check?.detail).toContain('PDF Seal Test Signing CA');
  });

  it('warns rather than fails when the chain simply stops short of a root', () => {
    // Omitting the root is normal and correct -- it belongs in the verifier's
    // trust store, not in the document.
    const certs = pool().filter((c) => c.subject.commonName !== 'PDF Seal Test Root CA');
    const built = buildChain(certs[0], certs, { id: 'c1' });

    expect(built.complete).toBe(false);
    const rootCheck = find(built.checks, 'chain.root');
    expect(rootCheck?.status).toBe('warn');
    expect(rootCheck?.explanation).toMatch(/trust store/i);
  });

  it('handles a lone self-signed certificate', async () => {
    const solo = parseCertificate((await mint({ commonName: 'Solo Root', isCa: true })).der);
    const built = buildChain(solo, [solo], { id: 'c1' });

    expect(built.certificateIds).toEqual([solo.id]);
    expect(solo.role).toBe('root');
    expect(built.complete).toBe(true);
    expect(find(built.checks, 'chain.issuerRelationship')?.status).toBe('pass');
  });

  it('does not loop forever on a cross-certified pair', async () => {
    // Two CAs that each name the other as issuer.
    const a = await mint({ commonName: 'Cross A', isCa: true });
    const b = await mint({ commonName: 'Cross B', isCa: true, issuer: a });
    const aCrossed = await mint({ commonName: 'Cross A', isCa: true, issuer: b });

    const certs = [parseCertificate(aCrossed.der), parseCertificate(b.der)];
    const built = buildChain(certs[0], certs, { id: 'c1' });
    expect(built.certificateIds.length).toBeLessThanOrEqual(2);
  }, 20000);

  it('carries the signature field name through onto the chain', () => {
    const certs = pool();
    const built = buildChain(certs[0], certs, { id: 'c1', signatureFieldName: 'Signature1' });
    expect(built.signatureFieldName).toBe('Signature1');
  });
});

describe('checkLink: the cryptographic issuer check is real', () => {
  it('passes when the issuer really did sign the certificate', () => {
    const checks = checkLink(leaf, intermediate, 0);
    const crypto = find(checks, 'link.cryptographic');
    expect(crypto?.status).toBe('pass');
    expect(crypto?.detail).toContain('PDF Seal Test Signing CA');
  });

  it('fails when the names agree but the signature does not', async () => {
    // This is the fixture that separates a real check from a name comparison:
    // the issuer DN is correct, the SKI/AKI link is correct, and only the
    // cryptography disagrees.
    const impostor = await mint({ commonName: 'PDF Seal Test Signing CA', isCa: true });
    const forged = await mint({
      commonName: 'Forged Signer',
      issuer: chain.intermediate,
      signWith: impostor.privateKey,
    });

    const forgedCert = parseCertificate(forged.der);
    const checks = checkLink(forgedCert, intermediate, 0);

    expect(find(checks, 'link.dn')?.status).toBe('pass');
    expect(find(checks, 'link.akiSki')?.status).toBe('pass');
    expect(find(checks, 'link.cryptographic')?.status).toBe('fail');
    expect(find(checks, 'link.cryptographic')?.explanation).toMatch(/names agree and the cryptography does not/i);
  }, 20000);

  it('fails the name check when the issuer DN does not match', () => {
    const checks = checkLink(leaf, root, 0);
    expect(find(checks, 'link.dn')?.status).toBe('fail');
    expect(find(checks, 'link.cryptographic')?.status).toBe('fail');
  });

  it('matches the authority key identifier against the issuer subject key identifier', () => {
    expect(find(checkLink(leaf, intermediate, 0), 'link.akiSki')?.status).toBe('pass');
  });

  it('reports the key identifier check as unknown when either side lacks one', async () => {
    const issuer = await mint({ commonName: 'No SKI CA', isCa: true, omitKeyIdentifiers: true });
    const child = await mint({ commonName: 'Child', issuer });
    const checks = checkLink(parseCertificate(child.der), parseCertificate(issuer.der), 0);

    expect(find(checks, 'link.akiSki')?.status).toBe('unknown');
    // The cryptographic check still runs and still passes.
    expect(find(checks, 'link.cryptographic')?.status).toBe('pass');
  }, 20000);

  it('reports the cryptographic check as unknown when a certificate is unparseable', () => {
    const broken = parseCertificate(new Uint8Array([1, 2, 3]));
    const checks = checkLink(broken, intermediate, 0);
    expect(find(checks, 'link.cryptographic')?.status).toBe('unknown');
  });

  it('enforces the path length constraint', async () => {
    // Root allows pathLen 0 beneath it, so a second CA below is one too many.
    const strictRoot = await mint({ commonName: 'Strict Root', isCa: true, pathLen: 0 });
    const ca = await mint({ commonName: 'Sub CA', isCa: true, issuer: strictRoot });

    const within = checkLink(parseCertificate(ca.der), parseCertificate(strictRoot.der), 0);
    expect(find(within, 'link.pathLen')?.status).toBe('pass');

    const beyond = checkLink(parseCertificate(ca.der), parseCertificate(strictRoot.der), 1);
    expect(find(beyond, 'link.pathLen')?.status).toBe('fail');
  }, 20000);

  it('omits the path length check when the issuer sets no limit', async () => {
    const openRoot = await mint({ commonName: 'Open Root', isCa: true });
    const checks = checkLink(leaf, parseCertificate(openRoot.der), 0);
    expect(find(checks, 'link.pathLen')).toBeUndefined();
  });
});

describe('checkCertificate', () => {
  it('reports everything as unparseable when the structure check fails', () => {
    const broken = parseCertificate(new Uint8Array([9, 9, 9]));
    const checks = checkCertificate(broken);
    expect(checks).toHaveLength(1);
    expect(find(checks, 'cert.parse')?.status).toBe('fail');
  });

  it('fails validity for an expired certificate', async () => {
    const expired = parseCertificate(
      (await mint({
        commonName: 'Expired',
        notBeforeOffsetMs: -86400000 * 400,
        notAfterOffsetMs: -86400000,
      })).der,
    );
    expired.role = 'signer';
    const check = find(checkCertificate(expired), 'cert.validity.window');
    expect(check?.status).toBe('fail');
    expect(check?.detail).toMatch(/^Expired on /);
  });

  it('fails validity for a certificate that is not valid yet', async () => {
    const future = parseCertificate(
      (await mint({ commonName: 'Future', notBeforeOffsetMs: 86400000 * 5 })).der,
    );
    future.role = 'signer';
    expect(find(checkCertificate(future), 'cert.validity.window')?.status).toBe('fail');
  });

  it('warns when a certificate is close to expiring', async () => {
    const soon = parseCertificate(
      (await mint({ commonName: 'Soon', notAfterOffsetMs: 86400000 * 10 })).der,
    );
    soon.role = 'signer';
    const check = find(checkCertificate(soon), 'cert.validity.window');
    expect(check?.status).toBe('warn');
    expect(check?.detail).toMatch(/Expires in \d+ days/);
  });

  it('separates validity today from validity at the claimed signing time', async () => {
    const expired = parseCertificate(
      (await mint({
        commonName: 'Valid When Signed',
        notBeforeOffsetMs: -86400000 * 400,
        notAfterOffsetMs: -86400000 * 10,
      })).der,
    );
    expired.role = 'signer';
    const signedAt = new Date(Date.now() - 86400000 * 200).toISOString();
    const checks = checkCertificate(expired, { signingTime: signedAt });

    // Expired today, but it was valid when the document was signed -- the whole
    // point of keeping these two apart.
    expect(find(checks, 'cert.validity.window')?.status).toBe('fail');
    expect(find(checks, 'cert.validity.atSigningTime')?.status).toBe('pass');
    expect(find(checks, 'cert.validity.atSigningTime')?.explanation).toMatch(/claimed by/i);
  });

  it('fails the signing-time check when the certificate was not yet valid then', () => {
    const cert = parseCertificate(chain.leaf.der);
    cert.role = 'signer';
    const longAgo = new Date(Date.now() - 86400000 * 3650).toISOString();
    expect(find(checkCertificate(cert, { signingTime: longAgo }), 'cert.validity.atSigningTime')?.status).toBe('fail');
  });

  it('reports the signing-time check as unknown when there is no signing time', () => {
    const cert = parseCertificate(chain.leaf.der);
    cert.role = 'signer';
    expect(find(checkCertificate(cert), 'cert.validity.atSigningTime')?.status).toBe('unknown');
  });

  it('reports the signing-time check as unknown when the time is unparseable', () => {
    const cert = parseCertificate(chain.leaf.der);
    cert.role = 'signer';
    const checks = checkCertificate(cert, { signingTime: 'not a date' });
    expect(find(checks, 'cert.validity.atSigningTime')?.status).toBe('unknown');
  });

  describe('basic constraints', () => {
    it('passes a CA that declares itself one', () => {
      const ca = parseCertificate(chain.intermediate.der);
      ca.role = 'intermediate';
      const check = find(checkCertificate(ca), 'cert.basicConstraints');
      expect(check?.status).toBe('pass');
      expect(check?.detail).toContain('cA=true');
    });

    it('fails a CA with no basic constraints at all', async () => {
      const cert = parseCertificate(
        (await mint({ commonName: 'Undeclared CA', omitBasicConstraints: true })).der,
      );
      cert.role = 'intermediate';
      expect(find(checkCertificate(cert), 'cert.basicConstraints')?.status).toBe('fail');
    });

    it('fails a CA whose basic constraints say cA=false', () => {
      const cert = parseCertificate(chain.leaf.der);
      cert.role = 'intermediate';
      const check = find(checkCertificate(cert), 'cert.basicConstraints');
      expect(check?.status).toBe('fail');
      expect(check?.detail).toContain('cA=false');
    });

    it('warns when a signer also declares itself a CA', () => {
      const cert = parseCertificate(chain.root.der);
      cert.role = 'signer';
      expect(find(checkCertificate(cert), 'cert.basicConstraints')?.status).toBe('warn');
    });

    it('passes a signer with no basic constraints', async () => {
      const cert = parseCertificate(
        (await mint({ commonName: 'Plain Signer', omitBasicConstraints: true })).der,
      );
      cert.role = 'signer';
      const check = find(checkCertificate(cert), 'cert.basicConstraints');
      expect(check?.status).toBe('pass');
      expect(check?.detail).toMatch(/Not present/);
    });
  });

  describe('key usage', () => {
    it('passes a signer permitted to sign', () => {
      const cert = parseCertificate(chain.leaf.der);
      cert.role = 'signer';
      expect(find(checkCertificate(cert), 'cert.keyUsage')?.status).toBe('pass');
    });

    it('fails a signer whose critical key usage forbids signing', async () => {
      const cert = parseCertificate(
        (await mint({ commonName: 'No Signing', keyUsage: ['keyEncipherment'] })).der,
      );
      cert.role = 'signer';
      const check = find(checkCertificate(cert), 'cert.keyUsage');
      expect(check?.status).toBe('fail');
      expect(check?.explanation).toMatch(/critical/i);
    });

    it('passes a signer that states no key usage restriction', async () => {
      const cert = parseCertificate((await mint({ commonName: 'Unrestricted' })).der);
      cert.extensions.keyUsage = null;
      cert.role = 'signer';
      expect(find(checkCertificate(cert), 'cert.keyUsage')?.status).toBe('pass');
    });

    it('fails a CA that may not sign certificates', () => {
      const cert = parseCertificate(chain.leaf.der);
      cert.role = 'intermediate';
      expect(find(checkCertificate(cert), 'cert.keyUsage')?.status).toBe('fail');
    });

    it('reports unknown for a CA that states no key usage', () => {
      const cert = parseCertificate(chain.intermediate.der);
      cert.extensions.keyUsage = null;
      cert.role = 'intermediate';
      expect(find(checkCertificate(cert), 'cert.keyUsage')?.status).toBe('unknown');
    });
  });

  describe('extended key usage', () => {
    it('passes a recognised document-signing purpose', () => {
      const cert = parseCertificate(chain.leaf.der);
      cert.role = 'signer';
      expect(find(checkCertificate(cert), 'cert.eku')?.status).toBe('pass');
    });

    it('warns but never fails on an unexpected purpose', async () => {
      const cert = parseCertificate(
        (await mint({ commonName: 'Server Cert', eku: ['1.3.6.1.5.5.7.3.1'] })).der,
      );
      cert.role = 'signer';
      const check = find(checkCertificate(cert), 'cert.eku');
      expect(check?.status).toBe('warn');
      expect(check?.explanation).toMatch(/Practice\s+varies/i);
    });

    it('passes when no extended key usage is stated', async () => {
      const cert = parseCertificate((await mint({ commonName: 'No EKU' })).der);
      cert.role = 'signer';
      expect(find(checkCertificate(cert), 'cert.eku')?.status).toBe('pass');
    });
  });

  it('passes a root that verifies against its own key', () => {
    const cert = parseCertificate(chain.root.der);
    cert.role = 'root';
    expect(find(checkCertificate(cert), 'cert.selfSigned')?.status).toBe('pass');
  });

  it('fails a root whose self-signature does not verify', async () => {
    const other = await mint({ commonName: 'Other', isCa: true });
    const forged = parseCertificate(
      (await mint({ commonName: 'Fake Root', isCa: true, signWith: other.privateKey })).der,
    );
    forged.role = 'root';
    expect(find(checkCertificate(forged), 'cert.selfSigned')?.status).toBe('fail');
  }, 20000);

  it('warns that a self-signed signer vouches only for itself', async () => {
    const cert = parseCertificate((await mint({ commonName: 'Self Signer' })).der);
    cert.role = 'signer';
    const check = find(checkCertificate(cert), 'cert.selfSigned');
    expect(check?.status).toBe('warn');
    expect(check?.explanation).toMatch(/vouches only for itself/i);
  });

  it('warns about a weak signature hash', () => {
    const cert = parseCertificate(chain.leaf.der);
    cert.role = 'signer';
    cert.signatureAlgorithm = { oid: '1.2.840.113549.1.1.5', name: 'RSA with SHA-1', hash: 'SHA-1' };
    expect(find(checkCertificate(cert), 'cert.signatureAlgorithm')?.status).toBe('warn');
  });

  it('warns about an RSA key below 2048 bits', () => {
    const cert = parseCertificate(chain.leaf.der);
    cert.role = 'signer';
    cert.publicKey = { algorithm: 'rsa', keySize: 1024, namedCurve: null, exponent: '65537' };
    expect(find(checkCertificate(cert), 'cert.keyStrength')?.status).toBe('warn');
  });

  it('does not warn about a 2048-bit RSA key', () => {
    const cert = parseCertificate(chain.leaf.der);
    cert.role = 'signer';
    cert.publicKey = { algorithm: 'rsa', keySize: 2048, namedCurve: null, exponent: '65537' };
    expect(find(checkCertificate(cert), 'cert.keyStrength')).toBeUndefined();
  });

  it('surfaces critical extensions it cannot decode', async () => {
    const cert = parseCertificate(
      (await mint({ commonName: 'Mystery', unknownCriticalExtension: '1.3.6.1.4.1.4242.1' })).der,
    );
    cert.role = 'signer';
    const check = find(checkCertificate(cert), 'cert.criticalExtensions');
    expect(check?.status).toBe('warn');
    expect(check?.detail).toContain('1.3.6.1.4.1.4242.1');
  });
});

describe('chain-level checks', () => {
  it('never claims trust, and says why', () => {
    const certs = pool();
    const built = buildChain(certs[0], certs, { id: 'c1' });
    const trust = find(built.checks, 'chain.trust');

    expect(trust?.status).toBe('unknown');
    expect(trust?.explanation).toBe(TRUST_NOTE);
    expect(trust?.explanation).toMatch(/no trust store/i);
  });

  it('never claims a revocation check', () => {
    const certs = pool();
    const built = buildChain(certs[0], certs, { id: 'c1' });
    const revocation = find(built.checks, 'chain.revocation');

    expect(revocation?.status).toBe('unknown');
    expect(revocation?.explanation).toMatch(/makes no network requests/i);
  });

  it('rolls the link results up into one issuer-relationship result', () => {
    const certs = pool();
    const built = buildChain(certs[0], certs, { id: 'c1' });
    const check = find(built.checks, 'chain.issuerRelationship');
    expect(check?.status).toBe('pass');
    expect(check?.detail).toContain('2 links');
  });

  it('names the expired certificates in the chain validity result', async () => {
    const expiredRoot = await mint({
      commonName: 'Old Root',
      isCa: true,
      notBeforeOffsetMs: -86400000 * 800,
      notAfterOffsetMs: -86400000 * 5,
    });
    const child = await mint({ commonName: 'Child Signer', issuer: expiredRoot });
    const certs = [parseCertificate(child.der), parseCertificate(expiredRoot.der)];
    const built = buildChain(certs[0], certs, { id: 'c1' });

    const check = find(built.checks, 'chain.validityNow');
    expect(check?.status).toBe('fail');
    expect(check?.detail).toContain('Old Root');
  }, 20000);

  it('reports chain validity at signing time only when a signing time is given', () => {
    const certs = pool();
    const withoutTime = buildChain(certs[0], certs, { id: 'c1' });
    expect(find(withoutTime.checks, 'chain.validityAtSigningTime')).toBeUndefined();

    const certs2 = pool();
    const withTime = buildChain(certs2[0], certs2, {
      id: 'c1',
      context: { signingTime: new Date().toISOString() },
    });
    expect(find(withTime.checks, 'chain.validityAtSigningTime')?.status).toBe('pass');
  });
});

describe('buildChains', () => {
  it('builds one chain per signer and reports what is left over', async () => {
    const second = await mintStandardChain();
    const certificates = [
      parseCertificate(chain.leaf.der),
      parseCertificate(chain.intermediate.der),
      parseCertificate(chain.root.der),
      parseCertificate(second.leaf.der),
      parseCertificate(second.intermediate.der),
      parseCertificate(second.root.der),
      parseCertificate((await mint({ commonName: 'Bystander CA', isCa: true })).der),
    ];

    const { chains, unchainedIds } = buildChains(certificates, [
      { certificateId: certificates[0].id, signatureFieldName: 'Signature1' },
      { certificateId: certificates[3].id, signatureFieldName: 'Signature2' },
    ]);

    expect(chains).toHaveLength(2);
    expect(chains[0].signatureFieldName).toBe('Signature1');
    expect(chains[1].signatureFieldName).toBe('Signature2');
    expect(chains[0].certificateIds).toHaveLength(3);
    expect(chains[1].certificateIds).toHaveLength(3);
    expect(chains.map((c) => c.id)).toEqual(['chain-1', 'chain-2']);

    expect(unchainedIds).toEqual([certificates[6].id]);
  }, 40000);

  it('still runs checks on certificates no signature reaches', async () => {
    const bystander = parseCertificate((await mint({ commonName: 'Orphan CA', isCa: true })).der);
    const { unchainedIds } = buildChains([bystander], []);

    expect(unchainedIds).toEqual([bystander.id]);
    expect(bystander.role).toBe('root');
    expect(bystander.checks.length).toBeGreaterThan(0);
  });

  it('classifies an unchained non-self-signed CA as an intermediate', () => {
    const orphanIntermediate = parseCertificate(chain.intermediate.der);
    buildChains([orphanIntermediate], []);
    expect(orphanIntermediate.role).toBe('intermediate');
  });

  it('skips a signer whose certificate is not among the certificates', () => {
    const { chains } = buildChains(pool(), [
      { certificateId: 'nope', signatureFieldName: 'Signature1' },
    ]);
    expect(chains).toEqual([]);
  });
});
