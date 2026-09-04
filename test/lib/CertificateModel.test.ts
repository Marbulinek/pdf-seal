import { describe, it, expect, beforeAll } from 'vitest';
import {
  parseCertificate,
  parseCertificateFile,
  certificateFingerprints,
  certificateDisplayName,
  derToPem,
} from '../../lib/CertificateModel';
import { mint, mintStandardChain, type StandardChain } from './helpers/certificateFactory';

let chain: StandardChain;

beforeAll(async () => {
  chain = await mintStandardChain();
}, 30000);

describe('parseCertificate: identity', () => {
  it('reads the subject and issuer as separate, structured names', () => {
    const cert = parseCertificate(chain.leaf.der);

    expect(cert.parseError).toBeNull();
    expect(cert.subject.commonName).toBe('Jane Doe');
    expect(cert.subject.organization).toBe('PDF Seal Test');
    expect(cert.issuer.commonName).toBe('PDF Seal Test Signing CA');
    expect(cert.subject.parts.map((p) => p.shortName)).toContain('CN');
  });

  it('formats a DN most-specific-first, the way certificate viewers do', () => {
    // The root is minted CN, O, C -- DER order is the reverse of display order.
    const root = parseCertificate(chain.root.der);
    expect(root.subject.formatted).toBe('C=CZ, O=PDF Seal Test, CN=PDF Seal Test Root CA');
  });

  it('falls back through CN, then O, then the full DN for a display name', async () => {
    const cert = parseCertificate(chain.leaf.der);
    expect(certificateDisplayName(cert)).toBe('Jane Doe');

    cert.subject.commonName = null;
    expect(certificateDisplayName(cert)).toBe('PDF Seal Test');

    cert.subject.organization = null;
    expect(certificateDisplayName(cert)).toBe(cert.subject.formatted);

    cert.subject.formatted = '';
    expect(certificateDisplayName(cert)).toBe('Unnamed certificate');
  });

  it('reports version 3 rather than the raw ASN.1 integer 2', () => {
    expect(parseCertificate(chain.leaf.der).version).toBe(3);
  });

  it('uses the sha256 fingerprint as the id, and it is stable', () => {
    const a = parseCertificate(chain.leaf.der);
    const b = parseCertificate(chain.leaf.der);
    expect(a.id).toBe(b.id);
    expect(a.id).toMatch(/^[0-9a-f]{64}$/);
    expect(a.id).toBe(certificateFingerprints(chain.leaf.der).sha256);
    expect(a.id).not.toBe(parseCertificate(chain.root.der).id);
  });
});

describe('parseCertificate: validity', () => {
  it('marks a current certificate as neither expired nor pending', () => {
    const cert = parseCertificate(chain.leaf.der);
    expect(cert.isExpired).toBe(false);
    expect(cert.isNotYetValid).toBe(false);
    expect(cert.daysUntilExpiry).toBeGreaterThan(300);
    expect(new Date(cert.validFrom).getTime()).toBeLessThan(Date.now());
  });

  it('detects an expired certificate', async () => {
    const expired = await mint({
      commonName: 'Expired Signer',
      notBeforeOffsetMs: -86400000 * 400,
      notAfterOffsetMs: -86400000,
    });
    const cert = parseCertificate(expired.der);
    expect(cert.isExpired).toBe(true);
    expect(cert.isNotYetValid).toBe(false);
    expect(cert.daysUntilExpiry).toBeLessThan(0);
  });

  it('detects a certificate that is not valid yet', async () => {
    const future = await mint({
      commonName: 'Future Signer',
      notBeforeOffsetMs: 86400000 * 10,
      notAfterOffsetMs: 86400000 * 400,
    });
    const cert = parseCertificate(future.der);
    expect(cert.isNotYetValid).toBe(true);
    expect(cert.isExpired).toBe(false);
  });

  it('counts the days left so a near-expiry warning can be raised', async () => {
    const soon = await mint({ commonName: 'Expiring Soon', notAfterOffsetMs: 86400000 * 20 });
    const cert = parseCertificate(soon.der);
    expect(cert.daysUntilExpiry).toBeGreaterThanOrEqual(19);
    expect(cert.daysUntilExpiry).toBeLessThanOrEqual(20);
  });
});

describe('parseCertificate: keys and signature algorithm', () => {
  it('reports an EC key with its curve and no modulus length', () => {
    const cert = parseCertificate(chain.leaf.der);
    expect(cert.publicKey.algorithm).toBe('ec');
    expect(cert.publicKey.namedCurve).toBe('prime256v1');
    expect(cert.publicKey.keySize).toBeNull();
  });

  it('reports an RSA key with its modulus length and exponent', async () => {
    const rsaCert = await mint({ commonName: 'RSA Signer', rsa: true });
    const cert = parseCertificate(rsaCert.der);
    expect(cert.publicKey.algorithm).toBe('rsa');
    expect(cert.publicKey.keySize).toBe(2048);
    expect(cert.publicKey.exponent).toBeTruthy();
    expect(cert.publicKey.namedCurve).toBeNull();
  }, 20000);

  it('names the signature algorithm and its hash', () => {
    const cert = parseCertificate(chain.leaf.der);
    expect(cert.signatureAlgorithm.oid).toBe('1.2.840.10045.4.3.2');
    expect(cert.signatureAlgorithm.name).toBe('ECDSA with SHA-256');
    expect(cert.signatureAlgorithm.hash).toBe('SHA-256');
  });
});

describe('parseCertificate: self-issued and self-signed', () => {
  it('recognises a self-signed root', () => {
    const root = parseCertificate(chain.root.der);
    expect(root.selfIssued).toBe(true);
    expect(root.selfSigned).toBe(true);
  });

  it('does not call an issued certificate self-issued', () => {
    const leaf = parseCertificate(chain.leaf.der);
    expect(leaf.selfIssued).toBe(false);
    expect(leaf.selfSigned).toBe(false);
  });

  it('is self-issued but NOT self-signed when the signature does not match the name', async () => {
    // Same subject and issuer DN, but signed by somebody else's key. This is the
    // case a name-only comparison would wave through.
    const other = await mint({ commonName: 'Impostor Root', isCa: true });
    const forged = await mint({
      commonName: 'Impostor Root',
      isCa: true,
      signWith: other.privateKey,
    });
    const cert = parseCertificate(forged.der);
    expect(cert.selfIssued).toBe(true);
    expect(cert.selfSigned).toBe(false);
  });
});

describe('parseCertificate: extensions', () => {
  it('decodes BasicConstraints including the path length', () => {
    const root = parseCertificate(chain.root.der);
    expect(root.extensions.basicConstraints).toEqual({
      critical: true,
      isCa: true,
      pathLenConstraint: 2,
    });

    const leaf = parseCertificate(chain.leaf.der);
    expect(leaf.extensions.basicConstraints?.isCa).toBe(false);
    expect(leaf.extensions.basicConstraints?.pathLenConstraint).toBeNull();
  });

  it('decodes KeyUsage bits in RFC 5280 order', () => {
    const leaf = parseCertificate(chain.leaf.der);
    expect(leaf.extensions.keyUsage?.usages).toEqual(['digitalSignature', 'contentCommitment']);
    expect(leaf.extensions.keyUsage?.critical).toBe(true);

    const root = parseCertificate(chain.root.der);
    expect(root.extensions.keyUsage?.usages).toEqual(['keyCertSign', 'cRLSign']);
  });

  it('decodes a KeyUsage bit past the first byte', async () => {
    const odd = await mint({ commonName: 'Decipher Only', keyUsage: ['decipherOnly'] });
    expect(parseCertificate(odd.der).extensions.keyUsage?.usages).toEqual(['decipherOnly']);
  });

  it('decodes ExtendedKeyUsage and names the OIDs it knows', () => {
    const leaf = parseCertificate(chain.leaf.der);
    expect(leaf.extensions.extendedKeyUsage?.oids).toEqual(['1.3.6.1.5.5.7.3.36']);
    expect(leaf.extensions.extendedKeyUsage?.names).toEqual(['documentSigning']);
  });

  it('passes an unknown EKU OID through unchanged rather than inventing a name', async () => {
    const odd = await mint({ commonName: 'Odd EKU', eku: ['1.3.6.1.4.1.55555.9'] });
    const cert = parseCertificate(odd.der);
    expect(cert.extensions.extendedKeyUsage?.names).toEqual(['1.3.6.1.4.1.55555.9']);
  });

  it('decodes the subject and authority key identifiers and links them', () => {
    const intermediate = parseCertificate(chain.intermediate.der);
    const leaf = parseCertificate(chain.leaf.der);

    expect(intermediate.extensions.subjectKeyIdentifier).toMatch(/^[0-9A-F]{40}$/);
    expect(leaf.extensions.authorityKeyIdentifier?.keyIdentifier).toBe(
      intermediate.extensions.subjectKeyIdentifier,
    );
  });

  it('decodes SANs, CRL distribution points, AIA and policies', () => {
    const leaf = parseCertificate(chain.leaf.der);
    expect(leaf.extensions.subjectAltNames).toEqual([
      { type: 'rfc822Name', value: 'jane@example.invalid' },
    ]);
    expect(leaf.extensions.crlDistributionPoints).toEqual(['http://crl.example.invalid/test.crl']);
    expect(leaf.extensions.authorityInfoAccess.ocsp).toEqual(['http://ocsp.example.invalid']);
    expect(leaf.extensions.authorityInfoAccess.caIssuers).toEqual([]);
    expect(leaf.extensions.certificatePolicies).toEqual([
      { oid: '1.3.6.1.4.1.99999.1.1', name: null, cps: 'https://example.invalid/cps' },
    ]);
  });

  it('reports an absent extension as null rather than inventing a default', async () => {
    const bare = await mint({
      commonName: 'Bare Certificate',
      omitBasicConstraints: true,
      omitKeyIdentifiers: true,
    });
    const cert = parseCertificate(bare.der);
    expect(cert.extensions.basicConstraints).toBeNull();
    expect(cert.extensions.subjectKeyIdentifier).toBeNull();
    expect(cert.extensions.authorityKeyIdentifier).toBeNull();
    expect(cert.extensions.extendedKeyUsage).toBeNull();
    expect(cert.extensions.subjectAltNames).toEqual([]);
    expect(cert.extensions.crlDistributionPoints).toEqual([]);
    expect(cert.extensions.certificatePolicies).toEqual([]);
  });

  it('surfaces a critical extension it cannot decode instead of ignoring it', async () => {
    const odd = await mint({
      commonName: 'Mystery Extension',
      unknownCriticalExtension: '1.3.6.1.4.1.55555.1',
    });
    const cert = parseCertificate(odd.der);
    expect(cert.extensions.unrecognizedCritical).toEqual(['1.3.6.1.4.1.55555.1']);
  });

  it('has a signer with no AKI when the issuer has no SKI to point at', async () => {
    const issuer = await mint({ commonName: 'No SKI CA', isCa: true, omitKeyIdentifiers: true });
    const leaf = await mint({ commonName: 'Child', issuer });
    expect(parseCertificate(leaf.der).extensions.authorityKeyIdentifier).toBeNull();
  });

  it('separates the OCSP and caIssuers entries in Authority Information Access', async () => {
    const cert = await mint({
      commonName: 'Both AIA',
      ocspUrl: 'http://ocsp.example.invalid',
      caIssuersUrl: 'http://ca.example.invalid/ca.cer',
    });
    const parsed = parseCertificate(cert.der);
    expect(parsed.extensions.authorityInfoAccess).toEqual({
      ocsp: ['http://ocsp.example.invalid'],
      caIssuers: ['http://ca.example.invalid/ca.cer'],
    });
  });

  it('renders a directoryName SAN as a formatted DN and an iPAddress SAN as dotted quad', async () => {
    const cert = await mint({
      commonName: 'Many SANs',
      subjectAltNames: [
        { type: 2, value: 'host.example.invalid' },
        { type: 6, value: 'https://example.invalid/id' },
      ],
      directoryAltName: 'Directory Entry',
      ipAltName: [192, 0, 2, 44],
    });
    const sans = parseCertificate(cert.der).extensions.subjectAltNames;
    expect(sans).toEqual([
      { type: 'dNSName', value: 'host.example.invalid' },
      { type: 'uniformResourceIdentifier', value: 'https://example.invalid/id' },
      { type: 'directoryName', value: 'CN=Directory Entry' },
      { type: 'iPAddress', value: '192.0.2.44' },
    ]);
  });
});

describe('parseCertificate: distinguished name edge cases', () => {
  it('picks up OU and email, and keeps an unknown attribute under its raw OID', async () => {
    const cert = await mint({
      commonName: 'Full DN',
      organization: 'PDF Seal Test',
      country: 'CZ',
      extraSubjectAttributes: [
        ['2.5.4.11', 'Engineering'],
        ['1.2.840.113549.1.9.1', 'dn@example.invalid'],
        ['1.3.6.1.4.1.77777.3', 'custom value'],
      ],
    });
    const subject = parseCertificate(cert.der).subject;

    expect(subject.organizationalUnit).toBe('Engineering');
    expect(subject.email).toBe('dn@example.invalid');
    expect(subject.country).toBe('CZ');

    const custom = subject.parts.find((p) => p.type === '1.3.6.1.4.1.77777.3');
    expect(custom).toEqual({
      type: '1.3.6.1.4.1.77777.3',
      shortName: '1.3.6.1.4.1.77777.3',
      value: 'custom value',
    });
    expect(subject.formatted).toContain('OU=Engineering');
    expect(subject.formatted).toContain('E=dn@example.invalid');
  });

  it('keeps the first occurrence when a DN repeats an attribute', async () => {
    const cert = await mint({
      commonName: 'First CN',
      extraSubjectAttributes: [['2.5.4.3', 'Second CN']],
    });
    const subject = parseCertificate(cert.der).subject;
    expect(subject.commonName).toBe('First CN');
    expect(subject.parts.filter((p) => p.shortName === 'CN')).toHaveLength(2);
  });
});

describe('parseCertificate: unreadable input', () => {
  it('never throws, and explains what went wrong', () => {
    const cert = parseCertificate(new Uint8Array([0x30, 0x03, 0x02, 0x01, 0x01]));
    expect(cert.parseError).toContain('not a certificate we can read');
  });

  it('still fingerprints unreadable bytes so they can be listed and removed', () => {
    const garbage = new Uint8Array([1, 2, 3, 4, 5]);
    const cert = parseCertificate(garbage);
    expect(cert.id).toBe(certificateFingerprints(garbage).sha256);
    expect(cert.derLength).toBe(5);
    expect(cert.subject.formatted).toBe('');
    expect(cert.extensions.basicConstraints).toBeNull();
  });
});

describe('derToPem', () => {
  it('wraps DER at 64 columns with the standard armour', () => {
    const pem = derToPem(chain.leaf.der);
    expect(pem.startsWith('-----BEGIN CERTIFICATE-----\n')).toBe(true);
    expect(pem.trimEnd().endsWith('-----END CERTIFICATE-----')).toBe(true);
    const body = pem.split('\n').slice(1, -2);
    expect(body.every((line) => line.length <= 64)).toBe(true);
  });

  it('round-trips back to the same DER', () => {
    const pem = derToPem(chain.leaf.der);
    const [again] = parseCertificateFile(Buffer.from(pem));
    expect(again.id).toBe(parseCertificate(chain.leaf.der).id);
  });
});

describe('parseCertificateFile', () => {
  it('reads a single PEM certificate', () => {
    const certs = parseCertificateFile(Buffer.from(chain.leaf.pem));
    expect(certs).toHaveLength(1);
    expect(certs[0].subject.commonName).toBe('Jane Doe');
  });

  it('reads a concatenated PEM chain in file order', () => {
    const bundle = chain.leaf.pem + chain.intermediate.pem + chain.root.pem;
    const certs = parseCertificateFile(Buffer.from(bundle));
    expect(certs.map((c) => c.subject.commonName)).toEqual([
      'Jane Doe',
      'PDF Seal Test Signing CA',
      'PDF Seal Test Root CA',
    ]);
  });

  it('reads bare DER', () => {
    const certs = parseCertificateFile(chain.root.der);
    expect(certs).toHaveLength(1);
    expect(certs[0].subject.commonName).toBe('PDF Seal Test Root CA');
  });

  it('rejects an empty file', () => {
    expect(() => parseCertificateFile(new Uint8Array(0))).toThrow(/empty/i);
  });

  it('refuses a file containing a private key', () => {
    const key = '-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n';
    expect(() => parseCertificateFile(Buffer.from(key))).toThrow(/private key/i);
  });

  it('refuses an encrypted private key too', () => {
    const key = '-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIB\n-----END ENCRYPTED PRIVATE KEY-----\n';
    expect(() => parseCertificateFile(Buffer.from(key))).toThrow(/private key/i);
  });

  it('rejects a file that is not DER or PEM at all', () => {
    expect(() => parseCertificateFile(Buffer.from('just some text'))).toThrow(
      /does not look like a certificate/i,
    );
  });

  it('rejects PEM armour with no readable block inside', () => {
    const broken = '-----BEGIN CERTIFICATE-----\n!!!!\n-----END CERTIFICATE-----\n';
    expect(() => parseCertificateFile(Buffer.from(broken))).toThrow(/no readable certificate/i);
  });

  it('rejects a DER SEQUENCE that is not a certificate', () => {
    expect(() => parseCertificateFile(new Uint8Array([0x30, 0x03, 0x02, 0x01, 0x01]))).toThrow(
      /not a certificate we can read/i,
    );
  });
});
