// Opt-in, per-request "would this chain be trusted against a bundle the user
// supplies" check. Deliberately kept out of CertificateChain.ts: that file's
// whole point is that chain.trust and chain.revocation are always 'unknown'
// because pdf-seal ships no trust store. This module never touches either of
// those fields, is never merged into a report's summary.status, and never
// makes a network call -- it only compares bytes the caller already has
// against bytes the user just uploaded.
//
// What it answers is path trust only: does every link of the chain verify, and
// does the chain end at (or under) a certificate the user chose to trust?
// Validity periods and revocation are not part of the answer.

import { checkLink } from './CertificateChain';
import { certificateDisplayName, type ParsedCertificate } from './CertificateModel';

export interface TrustSimulationResult {
  status: 'pass' | 'fail';
  detail: string;
  matchedRootSubject: string | null;
  extendedWithIssuer: boolean;
}

function fail(detail: string): TrustSimulationResult {
  return { status: 'fail', detail, matchedRootSubject: null, extendedWithIssuer: false };
}

/**
 * `chainCertificates` is leaf-first (the shape CertificateChain.buildChain
 * produces): [leaf, intermediate, ..., top]. `trustBundle` is whatever the
 * user just uploaded, parsed the same way any other certificate file is.
 */
export function simulateTrust(
  chainCertificates: ParsedCertificate[],
  trustBundle: ParsedCertificate[],
): TrustSimulationResult {
  const top = chainCertificates[chainCertificates.length - 1];
  if (!top) return fail('This chain has no certificates to evaluate.');

  // A trust anchor vouches for the path below it only if every step of that
  // path verifies. Walk from the leaf up, stopping at the first certificate
  // the user trusts: links above an anchor do not matter.
  for (let i = 0; i < chainCertificates.length; i++) {
    const cert = chainCertificates[i];
    const anchor = trustBundle.find((b) => b.fingerprints.sha256 === cert.fingerprints.sha256);
    if (anchor) {
      return {
        status: 'pass',
        detail:
          i === chainCertificates.length - 1 && cert.selfIssued
            ? `The root at the top of this chain (${cert.subject.formatted}) is present in your bundle.`
            : `${certificateDisplayName(cert)} is in your bundle, and every link below it verifies.`,
        matchedRootSubject: anchor.subject.formatted,
        extendedWithIssuer: false,
      };
    }

    const issuer = chainCertificates[i + 1];
    if (!issuer) break;
    const link = checkLink(cert, issuer, i).find((c) => c.id === 'link.cryptographic');
    if (link?.status !== 'pass') {
      return fail(
        `The chain is broken between ${certificateDisplayName(cert)} and ${certificateDisplayName(issuer)}: ` +
          `${link?.detail ?? 'the issuer signature could not be checked'}. No bundle can make it trusted.`,
      );
    }
  }

  for (const bundleCert of trustBundle) {
    const linkChecks = checkLink(top, bundleCert, chainCertificates.length - 1);
    if (linkChecks.find((c) => c.id === 'link.cryptographic')?.status === 'pass') {
      return {
        status: 'pass',
        detail: `A certificate in your bundle (${bundleCert.subject.formatted}) issues the top of this chain.`,
        matchedRootSubject: bundleCert.subject.formatted,
        extendedWithIssuer: true,
      };
    }
  }

  return fail(
    top.selfIssued
      ? `The chain ends at ${certificateDisplayName(top)}, which is not in your bundle.`
      : `No certificate in the uploaded bundle matches or issues the top of this chain. ` +
          `${certificateDisplayName(top)} was issued by “${top.issuer.formatted}”, which is neither ` +
          'in this file nor in your bundle.',
  );
}

export default { simulateTrust };
