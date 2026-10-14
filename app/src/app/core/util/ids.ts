// Random identifiers. crypto.getRandomValues works in insecure contexts too
// (unlike crypto.randomUUID), which matters for self-hosted http deployments.

const COMPACT_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function createCompactCode(length: number): string {
  const alphabet = COMPACT_ALPHABET;
  const bytesNeeded = Math.ceil((length * Math.log2(alphabet.length)) / 8) + 1;
  const bytes = new Uint8Array(bytesNeeded);
  crypto.getRandomValues(bytes);
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let code = '';
  for (let i = 0; i < length; i += 1) {
    code = alphabet[Number(value % BigInt(alphabet.length))] + code;
    value = value / BigInt(alphabet.length);
  }
  return code;
}

/** Short id for share sessions and stored version keys. */
export function createSessionId(): string {
  return createCompactCode(8);
}

/** Six-character share token the AES key is derived from. */
export function createCompactShareToken(): string {
  return createCompactCode(6);
}

/** UUID v4 without crypto.randomUUID() (which needs a secure context). */
export function createUuid(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function makeTemplateId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}
