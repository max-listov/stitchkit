/**
 * PKCE (RFC 7636) verification for the OAuth authorization-code flow. The client
 * sends a `code_challenge` at `/authorize` and the matching `code_verifier` at
 * `/token`; the server confirms they correspond so an intercepted code is
 * useless without the verifier.
 */
import { bytesToBase64Url } from '../../internal/base64url';

/** The only PKCE method OAuth 2.1 permits for public clients. */
export type PkceMethod = 'S256';

/** Derive the S256 `code_challenge` from a `code_verifier`. */
export async function deriveCodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return bytesToBase64Url(new Uint8Array(digest));
}

/**
 * Verify a `code_verifier` against the stored S256 `code_challenge`. S256 is the
 * only method OAuth 2.1 permits for public clients — `plain` is intentionally
 * not supported (it offers no protection against a leaked challenge).
 */
export async function verifyPkce(verifier: string, challenge: string): Promise<boolean> {
  if (!verifier || !challenge) return false;
  const derived = await deriveCodeChallenge(verifier);
  return derived === challenge;
}
