// Opt-in, per-request "would this chain be trusted against a bundle the user
// supplies" check. Deliberately kept out of CertificateChain.ts: that file's
// whole point is that chain.trust and chain.revocation are always 'unknown'
// because pdf-seal ships no trust store. This module never touches either of
// those fields, is never merged into a report's summary.status, and never
// makes a network call -- it only compares bytes the caller already has
// against bytes the user just uploaded.

import { checkLink } from './CertificateChain';
import type { ParsedCertificate } from './CertificateModel';

export interface TrustSimulationResult {
  status: 'pass' | 'fail';
  detail: string;
  matchedRootSubject: string | null;
  extendedWithIssuer: boolean;
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

  if (!top) {
    return {
      status: 'fail',
      detail: 'This chain has no certificates to evaluate.',
      matchedRootSubject: null,
      extendedWithIssuer: false,
    };
  }

  if (top.selfIssued) {
    const match = trustBundle.find((b) => b.fingerprints.sha256 === top.fingerprints.sha256);
    if (match) {
      return {
        status: 'pass',
        detail: `The root at the top of this chain (${top.subject.formatted}) is present in your bundle.`,
        matchedRootSubject: match.subject.formatted,
        extendedWithIssuer: false,
      };
    }
  }

  for (const bundleCert of trustBundle) {
    const linkChecks = checkLink(top, bundleCert, chainCertificates.length - 1);
    const cryptoOk = linkChecks.find((c) => c.id === 'link.cryptographic')?.status === 'pass';
    if (cryptoOk) {
      return {
        status: 'pass',
        detail: `A certificate in your bundle (${bundleCert.subject.formatted}) issues the top of this chain.`,
        matchedRootSubject: bundleCert.subject.formatted,
        extendedWithIssuer: true,
      };
    }
  }

  return {
    status: 'fail',
    detail: 'No certificate in the uploaded bundle matches or issues the top of this chain.',
    matchedRootSubject: null,
    extendedWithIssuer: false,
  };
}

export default { simulateTrust };
