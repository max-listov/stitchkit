/**
 * base64url over raw bytes — the one codec shared by cursor pagination, JWT
 * segments, OAuth-token minting and PKCE. `btoa`/`atob` based (not Node
 * `Buffer`), so it works identically in the server, the browser and the typed
 * client. Kept byte-level: string callers compose with `TextEncoder` /
 * `TextDecoder` themselves (pagination round-trips UTF-8; JWT/PKCE are binary).
 */

/** Encode raw bytes as an unpadded base64url string. */
export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Decode a base64url string to bytes. A character outside the alphabet, or a
 * length that no base64 string can have (`% 4 === 1`), is malformed — reject it
 * before `atob` rather than emit silent garbage.
 */
export function base64UrlToBytes(segment: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(segment) || segment.length % 4 === 1) {
    throw new Error('invalid base64url segment');
  }
  const b64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64.padEnd(Math.ceil(b64.length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}
