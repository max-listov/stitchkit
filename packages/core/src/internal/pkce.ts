import { bytesToBase64Url } from './base64url';

/** Derive the RFC 7636 S256 challenge with the caller's Web Crypto implementation. */
export async function deriveCodeChallenge(
  verifier: string,
  subtle: Pick<SubtleCrypto, 'digest'> = globalThis.crypto.subtle,
): Promise<string> {
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return bytesToBase64Url(new Uint8Array(digest));
}
