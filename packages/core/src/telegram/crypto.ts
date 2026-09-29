/**
 * The two cryptographic steps Telegram's protocols share: an HMAC-SHA-256 over
 * WebCrypto, so it runs on Bun, Node and anything with `crypto.subtle`, and a
 * comparison that does not say where two values first differ.
 */

const encoder = new TextEncoder();

export async function hmacSha256(
  key: ArrayBuffer | Uint8Array,
  message: string,
): Promise<ArrayBuffer> {
  const imported = await crypto.subtle.importKey(
    'raw',
    key as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return crypto.subtle.sign('HMAC', imported, encoder.encode(message));
}

export function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}

/**
 * Compare two strings without leaking where they first differ.
 *
 * A plain `===` on a digest returns as soon as one byte disagrees, and the time
 * it took is a measurement of how much of the digest was right. The whole point
 * of the comparison is that an attacker cannot get a partial answer.
 */
export function digestsEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
}
