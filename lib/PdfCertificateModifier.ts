// Rewrites the certificates inside a signature, for developer and tester
// workflows: producing a PDF with a deliberately incomplete chain, or one whose
// signer certificate no longer matches the key that signed it.
//
// The write is an in-place, length-preserving byte patch of the /Contents hex
// slot -- never a pdf-lib re-save. That is not a micro-optimisation, it is the
// only correct approach: pdf-lib rewrites the whole file, which moves every
// offset and invalidates /ByteRange for *every* signature in the document, not
// just the one being modified. Patching the slot leaves every other byte
// untouched, so the resulting file differs from the original in exactly the
// region a reader would expect and nowhere else.
//
// A signer reserves a fixed-size slot and zero-pads the unused tail, so a
// re-encoded CMS that is shorter simply gets more padding. One that is longer
// does not fit, and the operation is refused with both numbers rather than
// producing a corrupt file.
//
// What this does to a signature is worth being precise about, because it is not
// uniform. The certificate set inside a CMS SignedData is *not* covered by the
// signature, so removing or replacing a CA certificate leaves the signature
// cryptographically valid and only breaks chain building. Replacing the signer
// certificate is different: the public key no longer matches, and the signature
// genuinely stops verifying.

import * as pkijs from 'pkijs';
import {
  ensureCryptoEngine,
  parseCertificate,
  certificateFingerprints,
  certificateDisplayName,
  type ParsedCertificate,
} from './CertificateModel';
import {
  extractCertificateSources,
  findCmsSlot,
  readCmsFromSlotDetailed,
  type CmsSlot,
} from './PdfCertificateExtractor';

export type CertificateOperationName =
  | 'remove-certificate'
  | 'remove-intermediates'
  | 'replace-signer'
  | 'replace-chain';

export interface CertificateOperation {
  op: CertificateOperationName;
  /** Which signature's CMS to rewrite. */
  signatureField: string;
  /** For 'remove-certificate': the SHA-256 id of the certificate to drop. */
  targetFingerprint?: string;
  /** For the replace operations: the DER of the replacement certificate(s). */
  replacementDer?: Uint8Array[];
}

export interface ModificationResult {
  bytes: Buffer;
  slotCapacityBytes: number;
  originalDerLength: number;
  newDerLength: number;
  headroomBytes: number;
  /** True only when the signer certificate changed, which is what breaks it. */
  signatureNowInvalid: boolean;
  removedCertificates: string[];
  addedCertificates: string[];
  remainingCertificates: number;
  notes: string[];
}

/** Thrown for every refusal a user could reasonably act on. */
export class CertificateModificationError extends Error {
  constructor(message: string, readonly userFacing = true) {
    super(message);
    this.name = 'CertificateModificationError';
  }
}

const OID_SIGNED_DATA = '1.2.840.113549.1.7.2';

function derOf(cert: pkijs.Certificate): Uint8Array | null {
  try {
    return new Uint8Array(cert.toSchema(true).toBER(false));
  } catch {
    return null;
  }
}

function idOf(cert: pkijs.Certificate): string | null {
  const der = derOf(cert);
  return der ? certificateFingerprints(der).sha256 : null;
}

/**
 * Write a re-encoded CMS back into the slot it came from, padding the tail.
 *
 * Only the hex between the delimiters is touched, so the file's length and
 * every offset in it -- including the /ByteRange this slot is described by --
 * stay exactly as they were.
 */
function patchSlot(bytes: Uint8Array, slot: CmsSlot, cms: Uint8Array): Buffer {
  const capacityBytes = slot.capacityBytes;
  if (cms.length > capacityBytes) {
    throw new CertificateModificationError(
      `The rebuilt signature is ${cms.length} bytes but the space reserved for it in this PDF ` +
        `holds only ${capacityBytes}. The signature slot is a fixed size that cannot be grown ` +
        'without moving every byte after it, so this change cannot be applied to this document.',
    );
  }

  const out = Buffer.from(bytes);
  const hex = Buffer.from(cms).toString('hex').padEnd(capacityBytes * 2, '0');
  out.write(hex, slot.hexStart, 'latin1');
  return out;
}

/**
 * Apply one certificate change to one signature and return the new file.
 *
 * The original bytes are never mutated; callers get a fresh buffer.
 */
export async function applyCertificateOperation(
  bytes: Uint8Array,
  operation: CertificateOperation,
): Promise<ModificationResult> {
  ensureCryptoEngine();

  const { op, signatureField } = operation;

  const extraction = await extractCertificateSources(bytes);
  const signature = extraction.signatures.find((s) => s.fieldName === signatureField);
  if (!signature) {
    throw new CertificateModificationError(
      `This document has no signed signature field called "${signatureField}".`,
    );
  }
  if (!signature.byteRange || !signature.cmsSlot) {
    throw new CertificateModificationError(
      signature.cmsError ??
        'This signature’s content could not be located, so it cannot be modified.',
    );
  }

  const slot = findCmsSlot(bytes, signature.byteRange);
  if (!slot) {
    throw new CertificateModificationError(
      'This signature’s /ByteRange does not point at its content, so it cannot be modified.',
    );
  }

  const read = readCmsFromSlotDetailed(bytes, slot);
  if (!read.ok) {
    throw new CertificateModificationError(read.detail);
  }
  const originalCms = read.cms;
  slot.encoding = read.encoding;

  let contentInfo: pkijs.ContentInfo;
  let signedData: pkijs.SignedData;
  try {
    contentInfo = pkijs.ContentInfo.fromBER(originalCms);
    if (contentInfo.contentType !== OID_SIGNED_DATA) {
      throw new Error('not SignedData');
    }
    signedData = new pkijs.SignedData({ schema: contentInfo.content });
  } catch {
    throw new CertificateModificationError(
      'This signature does not hold a CMS SignedData structure, so its certificates cannot be changed.',
    );
  }

  const existing = (signedData.certificates ?? []).filter(
    (c): c is pkijs.Certificate => c instanceof pkijs.Certificate,
  );
  if (existing.length === 0) {
    throw new CertificateModificationError(
      'This signature carries no certificates, so there is nothing here to change.',
    );
  }

  const signerId = signature.signerCertificateId;
  const notes: string[] = [];
  const removedCertificates: string[] = [];
  const addedCertificates: string[] = [];
  let signerChanged = false;
  let next: pkijs.Certificate[];

  const describe = (cert: pkijs.Certificate): string => {
    const der = derOf(cert);
    return der ? certificateDisplayName(parseCertificate(der)) : 'a certificate';
  };

  switch (op) {
    case 'remove-certificate': {
      const target = operation.targetFingerprint;
      if (!target) {
        throw new CertificateModificationError('No certificate was selected for removal.');
      }
      next = [];
      let found = false;
      for (const cert of existing) {
        if (idOf(cert) === target) {
          found = true;
          removedCertificates.push(describe(cert));
          if (target === signerId) signerChanged = true;
          continue;
        }
        next.push(cert);
      }
      if (!found) {
        throw new CertificateModificationError(
          'That certificate is not inside this signature, so it cannot be removed from it. ' +
            'Certificates carried in the document security store are not part of the signature itself.',
        );
      }
      break;
    }

    case 'remove-intermediates': {
      // Keep the signer and anything self-issued (a root); drop the CAs in
      // between. This is the shape a tester wants when checking how a verifier
      // behaves against an incomplete chain.
      next = [];
      for (const cert of existing) {
        const der = derOf(cert);
        const parsed = der ? parseCertificate(der) : null;
        const isSigner = idOf(cert) === signerId;
        const isIntermediate = parsed
          ? !isSigner && !parsed.selfIssued && parsed.extensions.basicConstraints?.isCa === true
          : false;
        if (isIntermediate) {
          removedCertificates.push(describe(cert));
          continue;
        }
        next.push(cert);
      }
      if (removedCertificates.length === 0) {
        throw new CertificateModificationError(
          'This signature carries no intermediate CA certificates to remove.',
        );
      }
      break;
    }

    case 'replace-signer': {
      const replacement = operation.replacementDer?.[0];
      if (!replacement) {
        throw new CertificateModificationError('No replacement certificate was provided.');
      }
      const parsedReplacement = parseCertificate(replacement);
      if (parsedReplacement.parseError) {
        throw new CertificateModificationError(
          `The replacement certificate could not be read: ${parsedReplacement.parseError}`,
        );
      }
      if (!signerId) {
        throw new CertificateModificationError(
          'The signer certificate for this signature could not be identified, so there is nothing ' +
            'to replace. It may not be embedded in the document.',
        );
      }

      let newCert: pkijs.Certificate;
      try {
        newCert = pkijs.Certificate.fromBER(replacement);
      } catch {
        throw new CertificateModificationError('The replacement certificate could not be decoded.');
      }

      next = existing.map((cert) => {
        if (idOf(cert) !== signerId) return cert;
        removedCertificates.push(describe(cert));
        addedCertificates.push(certificateDisplayName(parsedReplacement));
        signerChanged = true;
        return newCert;
      });

      // CMS names its signer by issuer-and-serial or by key identifier. Left
      // pointing at the old certificate, nothing would resolve the signer at
      // all -- worse than an honestly broken signature.
      const signerInfo = signedData.signerInfos?.[0];
      if (signerInfo && signerInfo.sid instanceof pkijs.IssuerAndSerialNumber) {
        signerInfo.sid = new pkijs.IssuerAndSerialNumber({
          issuer: newCert.issuer,
          serialNumber: newCert.serialNumber,
        });
        notes.push(
          'The signer identifier inside the signature was updated to point at the replacement ' +
            'certificate, so it can still be located.',
        );
      } else if (signerInfo) {
        notes.push(
          'This signature identifies its signer by subject key identifier, which was left as it ' +
            'was. Verifiers may not be able to match the replacement certificate to the signature.',
        );
      }
      break;
    }

    case 'replace-chain': {
      const replacements = operation.replacementDer ?? [];
      if (replacements.length === 0) {
        throw new CertificateModificationError('No replacement certificates were provided.');
      }

      const parsedReplacements = replacements.map(parseCertificate);
      const bad = parsedReplacements.find((c) => c.parseError);
      if (bad) {
        throw new CertificateModificationError(
          `One of the replacement certificates could not be read: ${bad.parseError}`,
        );
      }

      // The signer is deliberately kept: replacing the CAs above it is the
      // useful test case, and swapping the signer too is what 'replace-signer'
      // is for.
      const signerCert = existing.find((cert) => idOf(cert) === signerId);
      if (!signerCert) {
        throw new CertificateModificationError(
          'The signer certificate for this signature could not be identified, so the chain above ' +
            'it cannot be replaced on its own.',
        );
      }

      for (const cert of existing) {
        if (idOf(cert) !== signerId) removedCertificates.push(describe(cert));
      }

      next = [signerCert];
      for (let i = 0; i < replacements.length; i++) {
        try {
          next.push(pkijs.Certificate.fromBER(replacements[i]));
          addedCertificates.push(certificateDisplayName(parsedReplacements[i]));
        } catch {
          throw new CertificateModificationError(
            'One of the replacement certificates could not be decoded.',
          );
        }
      }
      break;
    }

    default:
      throw new CertificateModificationError(`Unknown operation "${op}".`);
  }

  signedData.certificates = next;

  let newCms: Uint8Array;
  try {
    const rebuilt = new pkijs.ContentInfo({
      contentType: OID_SIGNED_DATA,
      content: signedData.toSchema(true),
    });
    newCms = new Uint8Array(rebuilt.toSchema().toBER(false));
  } catch (error: any) {
    throw new CertificateModificationError(
      `The signature could not be rebuilt after the change: ${error?.message ?? error}`,
    );
  }

  // Re-parse what we are about to write. A structure we cannot read back is one
  // no PDF reader could read either, and it is far better to refuse than to
  // hand back a file that silently fails to open.
  try {
    const check = new pkijs.SignedData({ schema: pkijs.ContentInfo.fromBER(newCms).content });
    const count = (check.certificates ?? []).length;
    if (count !== next.length) {
      throw new Error(`expected ${next.length} certificates, read back ${count}`);
    }
  } catch (error: any) {
    throw new CertificateModificationError(
      `The rebuilt signature did not survive a read-back check (${error?.message ?? error}), so ` +
        'the change was not applied.',
    );
  }

  const out = patchSlot(bytes, slot, newCms);

  if (slot.encoding === 'indefinite') {
    notes.push(
      'The original signature was written with BER indefinite lengths; the rebuilt one is written ' +
        'in DER. Both are valid CMS, but the content of the slot therefore differs by more than ' +
        'the certificates that changed.',
    );
  }

  if (signerChanged) {
    notes.push(
      'The signer certificate changed, so this signature will no longer verify: the public key it ' +
        'is checked against is not the key that made it.',
    );
  } else {
    notes.push(
      'The signer certificate was left alone. The certificate set inside a signature is not ' +
        'covered by the signature itself, so this signature still verifies cryptographically — ' +
        'only the chain around it changed.',
    );
  }

  return {
    bytes: out,
    slotCapacityBytes: slot.capacityBytes,
    originalDerLength: originalCms.length,
    newDerLength: newCms.length,
    headroomBytes: slot.capacityBytes - newCms.length,
    signatureNowInvalid: signerChanged,
    removedCertificates,
    addedCertificates,
    remainingCertificates: next.length,
    notes,
  };
}

/**
 * What each operation would do to this signature, without doing it.
 *
 * The panel uses this to describe a change before the user commits to it, and
 * to disable the ones that cannot apply -- a chain with no intermediates has
 * nothing to remove, and saying so up front beats an error afterwards.
 */
export function describeAvailableOperations(
  signature: { fieldName: string; signerCertificateId: string | null; certificateIds: string[] },
  certificates: ParsedCertificate[],
): Array<{ op: CertificateOperationName; available: boolean; reason: string | null }> {
  const own = certificates.filter((c) => signature.certificateIds.includes(c.id));
  const intermediates = own.filter(
    (c) =>
      c.id !== signature.signerCertificateId &&
      !c.selfIssued &&
      c.extensions.basicConstraints?.isCa === true,
  );
  const others = own.filter((c) => c.id !== signature.signerCertificateId);

  return [
    {
      op: 'remove-certificate',
      available: own.length > 1,
      reason: own.length > 1 ? null : 'This signature carries only one certificate.',
    },
    {
      op: 'remove-intermediates',
      available: intermediates.length > 0,
      reason: intermediates.length > 0 ? null : 'This signature carries no intermediate CA certificates.',
    },
    {
      op: 'replace-signer',
      available: Boolean(signature.signerCertificateId),
      reason: signature.signerCertificateId
        ? null
        : 'The signer certificate for this signature is not embedded in the document.',
    },
    {
      op: 'replace-chain',
      available: Boolean(signature.signerCertificateId) && others.length > 0,
      reason:
        !signature.signerCertificateId
          ? 'The signer certificate for this signature is not embedded in the document.'
          : others.length > 0
            ? null
            : 'This signature carries no CA certificates above the signer to replace.',
    },
  ];
}

export default { applyCertificateOperation, describeAvailableOperations, CertificateModificationError };
