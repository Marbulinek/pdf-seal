'use strict';

import { randomBytes } from 'crypto';

export interface MultipartPart {
  name: string;
  /** Presence of a filename is what makes a browser's formData().get() return a File/Blob instead of a string. */
  filename?: string;
  contentType?: string;
  data: Buffer;
}

export interface EncodedMultipart {
  boundary: string;
  body: Buffer;
}

const CRLF = '\r\n';

/**
 * Encode `parts` as a `multipart/form-data` body, the way a browser's own
 * `FormData` would -- built by hand here because the response side (a plain
 * server route, not a request) has no built-in multipart encoder.
 *
 * The boundary is `pdfseal-` plus 24 random hex bytes, regenerated (up to a
 * handful of times) until it's confirmed absent from every part's bytes --
 * otherwise a part containing a boundary-like sequence could prematurely
 * terminate the body.
 */
export function encodeMultipart(parts: MultipartPart[]): EncodedMultipart {
  let boundary = '';
  let collides = true;
  for (let attempt = 0; collides && attempt < 10; attempt++) {
    boundary = `pdfseal-${randomBytes(24).toString('hex')}`;
    collides = parts.some((part) => part.data.includes(boundary));
  }
  if (collides) {
    throw new Error('Could not generate a multipart boundary absent from the payload.');
  }

  const chunks: Buffer[] = [];
  for (const part of parts) {
    let header = `--${boundary}${CRLF}Content-Disposition: form-data; name="${part.name}"`;
    if (part.filename) header += `; filename="${part.filename}"`;
    header += CRLF;
    if (part.contentType) header += `Content-Type: ${part.contentType}${CRLF}`;
    header += CRLF;
    chunks.push(Buffer.from(header, 'utf8'));
    chunks.push(part.data);
    chunks.push(Buffer.from(CRLF, 'utf8'));
  }
  chunks.push(Buffer.from(`--${boundary}--${CRLF}`, 'utf8'));

  return { boundary, body: Buffer.concat(chunks) };
}

export default { encodeMultipart };
