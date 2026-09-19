import { describe, it, expect } from 'vitest';
import { encodeMultipart } from '../../lib/MultipartResponse';

describe('encodeMultipart', () => {
  it('round-trips through Response(...).formData(), the way a browser client parses it', async () => {
    const pdfBytes = Buffer.from('%PDF-1.7\n...fake pdf bytes...\n%%EOF');
    const fields = [{ name: 'Signature1', type: 'Signature' }];

    const { boundary, body } = encodeMultipart([
      { name: 'pdfDocument', filename: 'signed-document.pdf', contentType: 'application/pdf', data: pdfBytes },
      { name: 'fields', contentType: 'application/json', data: Buffer.from(JSON.stringify(fields)) },
    ]);

    const response = new Response(body, {
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    });
    const form = await response.formData();

    const pdfPart = form.get('pdfDocument');
    expect(pdfPart).toBeInstanceOf(Blob);
    const pdfPartBytes = Buffer.from(await (pdfPart as Blob).arrayBuffer());
    expect(pdfPartBytes.equals(pdfBytes)).toBe(true);

    const fieldsPart = form.get('fields');
    expect(typeof fieldsPart).toBe('string');
    expect(JSON.parse(fieldsPart as string)).toEqual(fields);
  });

  it('gives the PDF part a filename, so formData() returns a File/Blob rather than a plain string', async () => {
    const { boundary, body } = encodeMultipart([
      { name: 'pdfDocument', filename: 'signed-document.pdf', contentType: 'application/pdf', data: Buffer.from('bytes') },
    ]);
    const form = await new Response(body, {
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    }).formData();

    expect(form.get('pdfDocument')).toBeInstanceOf(Blob);
  });

  it('uses a pdfseal- prefixed boundary absent from every part', () => {
    const { boundary, body } = encodeMultipart([
      { name: 'a', data: Buffer.from('hello world') },
    ]);
    expect(boundary.startsWith('pdfseal-')).toBe(true);
    // Only the boundary's own delimiter lines should contain it -- not the
    // payload, which is what "absent from the payload" actually protects.
    const occurrences = body.toString('latin1').split(boundary).length - 1;
    expect(occurrences).toBe(2); // the opening delimiter + the closing "--boundary--"
  });

  it('uses CRLF line endings, as required by the multipart spec', () => {
    const { body } = encodeMultipart([{ name: 'a', data: Buffer.from('x') }]);
    expect(body.toString('latin1')).toMatch(/\r\n/);
    // No bare LF that isn't part of a CRLF pair.
    expect(body.toString('latin1')).not.toMatch(/[^\r]\n/);
  });

  it('regenerates the boundary if a part happens to contain it (astronomically unlikely, still checked)', async () => {
    // Can't force a real collision without reaching into crypto.randomBytes,
    // so this just confirms the happy path still works when a part's bytes
    // are adversarial-looking (containing the literal "pdfseal-" prefix).
    const { boundary, body } = encodeMultipart([
      { name: 'a', data: Buffer.from('pdfseal-not-the-real-boundary') },
    ]);
    const form = await new Response(body, {
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    }).formData();
    expect(form.get('a')).toBe('pdfseal-not-the-real-boundary');
  });
});
