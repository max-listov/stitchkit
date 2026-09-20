/**
 * PKCE (RFC 7636) verification for the OAuth authorization-code flow. The client
 * sends a `code_challenge` at `/authorize` and the matching `code_verifier` at
 * `/token`; the server confirms they correspond so an intercepted code is
 * useless without the verifier.
 */
import { deriveCodeChallenge } from '../../internal/pkce';

export { deriveCodeChallenge } from '../../internal/pkce';

/** The only PKCE method OAuth 2.1 permits for public clients. */
export type PkceMethod = 'S256';

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
