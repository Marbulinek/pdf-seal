import {
  analyzeBase64Pdf,
  base64UrlToBytes,
  bytesToBase64Url,
  formatBase64Text,
  quickCheckBase64Header,
  stripSurroundingQuotes,
} from './base64';

const PDF_B64 = btoa('%PDF-1.7\n%âãÏÓ\n1 0 obj');

describe('base64 helpers', () => {
  it('strips surrounding quotes', () => {
    expect(stripSurroundingQuotes(`"abc"`)).toBe('abc');
    expect(stripSurroundingQuotes(`'abc'`)).toBe('abc');
  });

  it('re-wraps pasted base64 at 76 columns and keeps a data: prefix', () => {
    const body = 'A'.repeat(100);
    const formatted = formatBase64Text(`  "data:application/pdf;base64,${body}"  `);
    expect(formatted.startsWith('data:application/pdf;base64,')).toBe(true);
    expect(formatted.split('\n')[0]).toHaveLength('data:application/pdf;base64,'.length + 76);
    expect(formatBase64Text('')).toBe('');
  });

  it('recognises a PDF by its magic bytes', () => {
    expect(analyzeBase64Pdf(PDF_B64).isPdf).toBe(true);
    expect(analyzeBase64Pdf(btoa('hello world')).isPdf).toBe(false);
    expect(() => analyzeBase64Pdf('***not base64***')).toThrow();
  });

  it('quick-checks only the header (tolerating a half-pasted string)', () => {
    expect(quickCheckBase64Header(`data:application/pdf;base64,${PDF_B64}`)).toBe(true);
    expect(quickCheckBase64Header('JVB')).toBe(false);
    expect(quickCheckBase64Header(btoa('GIF89a-image'))).toBe(false);
  });

  it('round-trips base64url', () => {
    const bytes = new Uint8Array([0, 251, 255, 62, 63, 128]);
    const encoded = bytesToBase64Url(bytes);
    expect(encoded).not.toMatch(/[+/=]/);
    expect(Array.from(base64UrlToBytes(encoded))).toEqual(Array.from(bytes));
  });
});
