// Base64 helpers for the "Upload as Base64" flow, the browser-extension
// hand-off and the share link key encoding.

const DATA_URL_PREFIX = /^data:application\/pdf;base64,/i;

/**
 * Copying a Base64 string from some sources (a JSON value, a quoted shell
 * variable) brings along a leading/trailing " or ' -- strip those first.
 */
export function stripSurroundingQuotes(value: string): string {
  return value.replace(/^["']+/, '').replace(/["']+$/, '');
}

/** Re-wraps pasted Base64 at 76 columns, keeping an optional data: prefix. */
export function formatBase64Text(rawValue: unknown): string {
  const trimmed = stripSurroundingQuotes(String(rawValue || '').trim());
  if (!trimmed) return '';

  const hasPrefix = DATA_URL_PREFIX.test(trimmed);
  const prefix = hasPrefix ? 'data:application/pdf;base64,' : '';
  const body = trimmed.replace(DATA_URL_PREFIX, '').replace(/\s+/g, '');

  if (!body) return prefix;

  const wrapped = body.match(/.{1,76}/g)?.join('\n') || body;
  return `${prefix}${wrapped}`;
}

function cleanBase64(rawInput: string): string {
  return stripSurroundingQuotes(rawInput.trim()).replace(DATA_URL_PREFIX, '').replace(/\s+/g, '');
}

export function base64ToBytes(rawInput: string): Uint8Array {
  const binary = atob(cleanBase64(rawInput));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Decodes `rawInput` and checks for the "%PDF-" magic bytes. Throws if the
 * text isn't valid Base64 at all; otherwise reports whether it's a PDF.
 */
export function analyzeBase64Pdf(rawInput: string): { bytes: Uint8Array; isPdf: boolean } {
  const bytes = base64ToBytes(rawInput);
  const header = String.fromCharCode(...bytes.slice(0, 5));
  return { bytes, isPdf: header === '%PDF-' };
}

/**
 * The live validity indicator re-runs on a debounce while the user types, so
 * -- unlike analyzeBase64Pdf() -- it only decodes enough to read the "%PDF-"
 * magic instead of the whole (possibly tens-of-megabytes) string.
 */
export function quickCheckBase64Header(rawInput: string): boolean {
  const cleaned = cleanBase64(rawInput);
  // 12 chars is a multiple of 4 (atob needs whole groups) and decodes to 9
  // bytes -- enough for the 5-byte magic. Floored to the input while shorter.
  const headLen = Math.min(12, cleaned.length - (cleaned.length % 4));
  if (headLen <= 0) return false;
  const binary = atob(cleaned.slice(0, headLen));
  return binary.slice(0, 5) === '%PDF-';
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** Reads a Blob as Base64 (without the data: URL prefix). */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(blob);
  });
}
