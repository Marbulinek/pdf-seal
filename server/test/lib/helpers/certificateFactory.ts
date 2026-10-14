// Mints real X.509 certificates for the certificate tests.
//
// Generating them here rather than checking in base64 blobs is what makes the
// interesting cases testable: validity windows are relative to now (so the
// expiry-warning band can be asserted without the fixture rotting), and a
// deliberately mis-signed certificate -- one whose issuer DN names a CA that
// did not actually sign it -- can be produced on demand. That fixture is the
// only thing that proves the cryptographic issuer check is real rather than a
// name comparison wearing a badge.
//
// P-256 is used throughout because keygen is ~1ms against RSA's ~100ms; mintRsa()
// exists for the handful of assertions that need a modulus length.

import * as pkijs from 'pkijs';
import * as asn1js from 'asn1js';
import { webcrypto } from 'node:crypto';
import { ensureCryptoEngine } from '../../../lib/CertificateModel';

ensureCryptoEngine();

export interface MintedCertificate {
  cert: pkijs.Certificate;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  der: Uint8Array;
  pem: string;
}

export interface MintOptions {
  commonName: string;
  organization?: string;
  country?: string;
  /** Certificate authority: sets BasicConstraints cA and KeyUsage keyCertSign. */
  isCa?: boolean;
  pathLen?: number;
  /** Milliseconds relative to now; defaults to a year either side. */
  notBeforeOffsetMs?: number;
  notAfterOffsetMs?: number;
  /** Omit to self-sign. */
  issuer?: MintedCertificate;
  /**
   * Sign with this key instead of the issuer's -- produces a certificate whose
   * issuer DN is correct but whose signature does not verify.
   */
  signWith?: CryptoKey;
  /** Extended key usage OIDs. Omitted entirely when undefined. */
  eku?: string[];
  /** Override the KeyUsage bits; omit for the isCa-appropriate default. */
  keyUsage?: string[];
  /** Skip BasicConstraints entirely (a CA that forgot to declare itself). */
  omitBasicConstraints?: boolean;
  /** Skip SubjectKeyIdentifier/AuthorityKeyIdentifier. */
  omitKeyIdentifiers?: boolean;
  /** Add a critical extension with an OID nothing decodes. */
  unknownCriticalExtension?: string;
  subjectAltNames?: Array<{ type: number; value: string }>;
  /** A directoryName SAN (GeneralName type 4), which carries a whole DN. */
  directoryAltName?: string;
  /** An iPAddress SAN (GeneralName type 7), as four raw bytes. */
  ipAltName?: [number, number, number, number];
  crlUrl?: string;
  ocspUrl?: string;
  caIssuersUrl?: string;
  policyOid?: string;
  /** Extra subject DN attributes beyond CN/O/C, as [oid, value] pairs. */
  extraSubjectAttributes?: Array<[string, string]>;
  rsa?: boolean;
}

const KEY_USAGE_BIT_ORDER = [
  'digitalSignature',
  'contentCommitment',
  'keyEncipherment',
  'dataEncipherment',
  'keyAgreement',
  'keyCertSign',
  'cRLSign',
  'encipherOnly',
  'decipherOnly',
];

let serialCounter = 0x1000;

function encodeKeyUsage(usages: string[]): asn1js.BitString {
  let highestBit = -1;
  const bytes = new Uint8Array(2);
  for (const usage of usages) {
    const bit = KEY_USAGE_BIT_ORDER.indexOf(usage);
    if (bit < 0) throw new Error(`unknown key usage in fixture: ${usage}`);
    bytes[Math.floor(bit / 8)] |= 0x80 >> bit % 8;
    if (bit > highestBit) highestBit = bit;
  }
  const usedBytes = highestBit < 8 ? 1 : 2;
  const unusedBits = usedBytes * 8 - (highestBit + 1);
  return new asn1js.BitString({
    valueHex: bytes.slice(0, usedBytes).buffer as ArrayBuffer,
    unusedBits,
  });
}

function dnEntry(type: string, value: string): pkijs.AttributeTypeAndValue {
  return new pkijs.AttributeTypeAndValue({ type, value: new asn1js.Utf8String({ value }) });
}

async function digestSha1(data: ArrayBuffer): Promise<ArrayBuffer> {
  return webcrypto.subtle.digest('SHA-1', data);
}

export async function mint(options: MintOptions): Promise<MintedCertificate> {
  const {
    commonName,
    organization,
    country,
    isCa = false,
    pathLen,
    notBeforeOffsetMs = -86400000,
    notAfterOffsetMs = 86400000 * 365,
    issuer,
    signWith,
    eku,
    keyUsage,
    omitBasicConstraints = false,
    omitKeyIdentifiers = false,
    unknownCriticalExtension,
    subjectAltNames,
    directoryAltName,
    ipAltName,
    crlUrl,
    ocspUrl,
    caIssuersUrl,
    policyOid,
    extraSubjectAttributes,
    rsa = false,
  } = options;

  const algorithm: any = rsa
    ? {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      }
    : { name: 'ECDSA', namedCurve: 'P-256' };

  const keys = (await webcrypto.subtle.generateKey(algorithm, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;

  const cert = new pkijs.Certificate();
  cert.version = 2;
  cert.serialNumber = new asn1js.Integer({ value: ++serialCounter });

  cert.subject.typesAndValues.push(dnEntry('2.5.4.3', commonName));
  if (organization) cert.subject.typesAndValues.push(dnEntry('2.5.4.10', organization));
  if (country) cert.subject.typesAndValues.push(dnEntry('2.5.4.6', country));
  for (const [oid, value] of extraSubjectAttributes ?? []) {
    cert.subject.typesAndValues.push(dnEntry(oid, value));
  }

  const issuerName = issuer ? issuer.cert.subject : cert.subject;
  for (const tv of issuerName.typesAndValues) {
    cert.issuer.typesAndValues.push(new pkijs.AttributeTypeAndValue({ type: tv.type, value: tv.value }));
  }

  const now = Date.now();
  cert.notBefore.value = new Date(now + notBeforeOffsetMs);
  cert.notAfter.value = new Date(now + notAfterOffsetMs);

  cert.extensions = [];

  if (!omitBasicConstraints) {
    const bc = new pkijs.BasicConstraints({
      cA: isCa,
      ...(isCa && typeof pathLen === 'number' ? { pathLenConstraint: pathLen } : {}),
    });
    cert.extensions.push(
      new pkijs.Extension({
        extnID: '2.5.29.19',
        critical: true,
        extnValue: bc.toSchema().toBER(false),
        parsedValue: bc,
      }),
    );
  }

  const usages = keyUsage ?? (isCa ? ['keyCertSign', 'cRLSign'] : ['digitalSignature', 'contentCommitment']);
  cert.extensions.push(
    new pkijs.Extension({
      extnID: '2.5.29.15',
      critical: true,
      extnValue: encodeKeyUsage(usages).toBER(false),
    }),
  );

  if (eku) {
    const extKeyUsage = new pkijs.ExtKeyUsage({ keyPurposes: eku });
    cert.extensions.push(
      new pkijs.Extension({
        extnID: '2.5.29.37',
        critical: false,
        extnValue: extKeyUsage.toSchema().toBER(false),
        parsedValue: extKeyUsage,
      }),
    );
  }

  await cert.subjectPublicKeyInfo.importKey(keys.publicKey, pkijs.getCrypto(true));

  if (!omitKeyIdentifiers) {
    const spkiBits = cert.subjectPublicKeyInfo.subjectPublicKey.valueBlock.valueHexView;
    const ski = await digestSha1(spkiBits.slice().buffer as ArrayBuffer);
    cert.extensions.push(
      new pkijs.Extension({
        extnID: '2.5.29.14',
        critical: false,
        extnValue: new asn1js.OctetString({ valueHex: ski }).toBER(false),
      }),
    );

    if (issuer) {
      const issuerSki = issuer.cert.extensions?.find((e) => e.extnID === '2.5.29.14');
      if (issuerSki) {
        const keyId = asn1js.fromBER(issuerSki.extnValue.valueBlock.valueHexView).result;
        const aki = new pkijs.AuthorityKeyIdentifier({
          keyIdentifier: new asn1js.OctetString({
            valueHex: (keyId as any).valueBlock.valueHexView.slice().buffer,
          }),
        });
        cert.extensions.push(
          new pkijs.Extension({
            extnID: '2.5.29.35',
            critical: false,
            extnValue: aki.toSchema().toBER(false),
            parsedValue: aki,
          }),
        );
      }
    }
  }

  if (subjectAltNames?.length || directoryAltName || ipAltName) {
    const names = (subjectAltNames ?? []).map(
      (n) => new pkijs.GeneralName({ type: n.type, value: n.value }),
    );
    if (directoryAltName) {
      names.push(
        new pkijs.GeneralName({
          type: 4,
          value: new pkijs.RelativeDistinguishedNames({
            typesAndValues: [dnEntry('2.5.4.3', directoryAltName)],
          }),
        }),
      );
    }
    if (ipAltName) {
      names.push(
        new pkijs.GeneralName({
          type: 7,
          value: new asn1js.OctetString({ valueHex: new Uint8Array(ipAltName).buffer }),
        }),
      );
    }
    const altNames = new pkijs.GeneralNames({ names });
    cert.extensions.push(
      new pkijs.Extension({
        extnID: '2.5.29.17',
        critical: false,
        extnValue: altNames.toSchema().toBER(false),
        parsedValue: altNames,
      }),
    );
  }

  if (crlUrl) {
    const crl = new pkijs.CRLDistributionPoints({
      distributionPoints: [
        new pkijs.DistributionPoint({
          distributionPoint: [new pkijs.GeneralName({ type: 6, value: crlUrl })],
        }),
      ],
    });
    cert.extensions.push(
      new pkijs.Extension({
        extnID: '2.5.29.31',
        critical: false,
        extnValue: crl.toSchema().toBER(false),
        parsedValue: crl,
      }),
    );
  }

  if (ocspUrl || caIssuersUrl) {
    const accessDescriptions: pkijs.AccessDescription[] = [];
    if (ocspUrl) {
      accessDescriptions.push(
        new pkijs.AccessDescription({
          accessMethod: '1.3.6.1.5.5.7.48.1',
          accessLocation: new pkijs.GeneralName({ type: 6, value: ocspUrl }),
        }),
      );
    }
    if (caIssuersUrl) {
      accessDescriptions.push(
        new pkijs.AccessDescription({
          accessMethod: '1.3.6.1.5.5.7.48.2',
          accessLocation: new pkijs.GeneralName({ type: 6, value: caIssuersUrl }),
        }),
      );
    }
    const aia = new pkijs.InfoAccess({ accessDescriptions });
    cert.extensions.push(
      new pkijs.Extension({
        extnID: '1.3.6.1.5.5.7.1.1',
        critical: false,
        extnValue: aia.toSchema().toBER(false),
        parsedValue: aia,
      }),
    );
  }

  if (policyOid) {
    const policies = new pkijs.CertificatePolicies({
      certificatePolicies: [
        new pkijs.PolicyInformation({
          policyIdentifier: policyOid,
          policyQualifiers: [
            new pkijs.PolicyQualifierInfo({
              policyQualifierId: '1.3.6.1.5.5.7.2.1',
              qualifier: new asn1js.IA5String({ value: 'https://example.invalid/cps' }),
            }),
          ],
        }),
      ],
    });
    cert.extensions.push(
      new pkijs.Extension({
        extnID: '2.5.29.32',
        critical: false,
        extnValue: policies.toSchema().toBER(false),
        parsedValue: policies,
      }),
    );
  }

  if (unknownCriticalExtension) {
    cert.extensions.push(
      new pkijs.Extension({
        extnID: unknownCriticalExtension,
        critical: true,
        extnValue: new asn1js.OctetString({ valueHex: new Uint8Array([0x01]).buffer }).toBER(false),
      }),
    );
  }

  const signingKey = signWith ?? issuer?.privateKey ?? keys.privateKey;
  await cert.sign(signingKey, 'SHA-256', pkijs.getCrypto(true));

  const der = new Uint8Array(cert.toSchema(true).toBER(false));
  const pem = `-----BEGIN CERTIFICATE-----\n${Buffer.from(der)
    .toString('base64')
    .replace(/(.{64})/g, '$1\n')
    .trimEnd()}\n-----END CERTIFICATE-----\n`;

  return { cert, privateKey: keys.privateKey, publicKey: keys.publicKey, der, pem };
}

export interface StandardChain {
  root: MintedCertificate;
  intermediate: MintedCertificate;
  leaf: MintedCertificate;
}

/** root (CA) -> intermediate (CA) -> leaf (document signing). */
export async function mintStandardChain(): Promise<StandardChain> {
  const root = await mint({
    commonName: 'PDF Seal Test Root CA',
    organization: 'PDF Seal Test',
    country: 'CZ',
    isCa: true,
    pathLen: 2,
    notAfterOffsetMs: 86400000 * 3650,
  });
  const intermediate = await mint({
    commonName: 'PDF Seal Test Signing CA',
    organization: 'PDF Seal Test',
    isCa: true,
    pathLen: 0,
    issuer: root,
    notAfterOffsetMs: 86400000 * 1825,
  });
  const leaf = await mint({
    commonName: 'Jane Doe',
    organization: 'PDF Seal Test',
    issuer: intermediate,
    eku: ['1.3.6.1.5.5.7.3.36'],
    crlUrl: 'http://crl.example.invalid/test.crl',
    ocspUrl: 'http://ocsp.example.invalid',
    policyOid: '1.3.6.1.4.1.99999.1.1',
    subjectAltNames: [{ type: 1, value: 'jane@example.invalid' }],
  });
  return { root, intermediate, leaf };
}

export default { mint, mintStandardChain };
