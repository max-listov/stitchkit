/**
 * The two cryptographic steps Telegram's protocols share: an HMAC-SHA-256 over
 * WebCrypto, so it runs on Bun, Node and anything with `crypto.subtle`. The
 * comparison that does not say where two values differ is `secretsEqual`.
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
