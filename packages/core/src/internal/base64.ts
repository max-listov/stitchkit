const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_LOOKUP = new Uint8Array(128).fill(255);
for (let i = 0; i < BASE64_ALPHABET.length; i += 1) {
  BASE64_LOOKUP[BASE64_ALPHABET.charCodeAt(i)] = i;
}

/** Encode raw bytes as standard base64 without depending on Node `Buffer` or `btoa` (Hermes-safe). */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    const triple = (a << 16) | (b << 8) | c;
    out += BASE64_ALPHABET[(triple >> 18) & 63];
    out += BASE64_ALPHABET[(triple >> 12) & 63];
    out += i + 1 < bytes.length ? BASE64_ALPHABET[(triple >> 6) & 63] : '=';
    out += i + 2 < bytes.length ? BASE64_ALPHABET[triple & 63] : '=';
  }
  return out;
}

/**
 * Decode standard padded base64 into bytes without depending on Node `Buffer` or `atob`
 * (Hermes-safe). Rejects malformed lengths, non-alphabet characters, and `=` padding outside
 * the final quartet.
 */
export function base64ToBytes(encoded: string): Uint8Array<ArrayBuffer> {
  const clean = encoded.replace(/[\t\n\f\r ]+/g, '');
  if (clean.length === 0) return new Uint8Array(new ArrayBuffer(0));
  if (clean.length % 4 !== 0) {
    throw new Error('Invalid base64 payload');
  }
  const firstPad = clean.indexOf('=');
  if (
    firstPad !== -1 &&
    (firstPad < clean.length - 2 ||
      (firstPad === clean.length - 2 && clean[clean.length - 1] !== '='))
  ) {
    throw new Error('Invalid base64 padding');
  }
  const padding = firstPad === -1 ? 0 : clean.length - firstPad;
  const byteLength = (clean.length / 4) * 3 - padding;
  const out = new Uint8Array(new ArrayBuffer(byteLength));
  let write = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = BASE64_LOOKUP[clean.charCodeAt(i)] ?? 255;
    const c1 = BASE64_LOOKUP[clean.charCodeAt(i + 1)] ?? 255;
    const c2 = clean[i + 2] === '=' ? 0 : (BASE64_LOOKUP[clean.charCodeAt(i + 2)] ?? 255);
    const c3 = clean[i + 3] === '=' ? 0 : (BASE64_LOOKUP[clean.charCodeAt(i + 3)] ?? 255);
    if (c0 === 255 || c1 === 255 || c2 === 255 || c3 === 255) {
      throw new Error('Invalid base64 character');
    }
    const triple = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;
    if (write < byteLength) out[write++] = (triple >> 16) & 255;
    if (write < byteLength) out[write++] = (triple >> 8) & 255;
    if (write < byteLength) out[write++] = triple & 255;
  }
  return out;
}
