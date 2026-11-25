/**
 * A link that carries its own short-lived proof, for the requests a page cannot add a header to.
 *
 * `<audio src>`, `<img src>` and a plain navigation send no `Authorization` header, so an endpoint
 * that serves private bytes cannot see the session the page holds. The server signs a link
 * instead: it appends an `expires` time and an HMAC-SHA-256 `signature` over the method, the path
 * and every query parameter, and checks both when the link comes back. Nothing is stored; the
 * secret is the server's. The host is not signed, so a link checked behind a proxy that changes
 * the origin still verifies — the path and query must reach the server as they were signed.
 *
 * Web Crypto only (`crypto.subtle`), so the core stays Fetch-clean (ADR 0013); the signature is
 * compared with `secretsEqual`, which does not say where two values differ.
 */
import { bytesToBase64Url } from '../../internal/base64url';
import { secretsEqual } from '../../internal/secret-equal';

/** The longest lifetime a link may be signed for: seven days, in seconds. */
export const MAX_SIGNED_LINK_SECONDS = 7 * 24 * 60 * 60;

const MIN_SECRET_LENGTH = 32;
const EXPIRES = 'expires';
const SIGNATURE = 'signature';
const METHOD = /^[A-Z]{1,16}$/;
const EXPIRES_VALUE = /^[0-9]{1,12}$/;
/** Resolves a relative link; never part of what is signed. */
const RELATIVE_BASE = 'http://signed-link.invalid';

/** What `signLink` signs: the one request a link may make, and for how long. */
export interface SignLinkOptions {
  /** The server's HMAC key, at least 32 characters. */
  readonly secret: string;
  /** The one method the link opens, upper case (`GET`). */
  readonly method: string;
  /** The path and query the request will carry (`/media/r1?for=u1`), or an absolute URL. */
  readonly url: string;
  /** How long the link opens the endpoint: a whole number of seconds, 1 to seven days. */
  readonly expiresInSeconds: number;
  readonly now?: () => Date;
}

/** What `verifySignedLink` checks a request against. */
export interface VerifySignedLinkOptions {
  /** The key the link was signed with. */
  readonly secret: string;
  readonly now?: () => Date;
}

/** Why a link was refused: no `signature`, a malformed one, past its `expires`, or not signed for this request. */
export type SignedLinkRefusal = 'unsigned' | 'malformed' | 'expired' | 'forged';

/** A link that opens this request until `expiresAt`, or the reason it does not. */
export type SignedLinkVerdict =
  | { readonly ok: true; readonly expiresAt: Date }
  | { readonly ok: false; readonly reason: SignedLinkRefusal };

function assertSecret(secret: string): void {
  if (secret.length < MIN_SECRET_LENGTH)
    throw new TypeError(`A signed-link secret needs at least ${MIN_SECRET_LENGTH} characters`);
}

/** The bytes the signature covers: method, path and the query without the signature, sorted by name. */
function signedText(method: string, url: URL): string {
  const query = new URLSearchParams(url.searchParams);
  query.delete(SIGNATURE);
  query.sort();
  return `${method}\n${url.pathname}\n${query.toString()}`;
}

async function hmac(secret: string, text: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return bytesToBase64Url(
    new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(text))),
  );
}

/**
 * Sign `url` for one `method` until `expiresInSeconds` from now; returns it with `expires` and
 * `signature` appended, relative if it was relative. A weak secret, a lifetime outside 1 second to
 * seven days, a lower-case method or a URL that already carries `expires` or `signature` throws.
 */
export async function signLink(options: SignLinkOptions): Promise<string> {
  assertSecret(options.secret);
  if (!METHOD.test(options.method))
    throw new TypeError(`"${options.method}" is not an upper-case HTTP method`);
  const lifetime = options.expiresInSeconds;
  if (!Number.isSafeInteger(lifetime) || lifetime < 1 || lifetime > MAX_SIGNED_LINK_SECONDS)
    throw new TypeError(
      `A link lives 1 to ${MAX_SIGNED_LINK_SECONDS} whole seconds, not ${lifetime}`,
    );
  const relative = !URL.canParse(options.url);
  const url = new URL(options.url, RELATIVE_BASE);
  if (url.searchParams.has(EXPIRES) || url.searchParams.has(SIGNATURE))
    throw new TypeError(
      `A link to sign must not carry "${EXPIRES}" or "${SIGNATURE}" already`,
    );
  const issued = (options.now ?? (() => new Date()))().getTime();
  url.searchParams.set(EXPIRES, String(Math.floor(issued / 1000) + lifetime));
  url.searchParams.set(SIGNATURE, await hmac(options.secret, signedText(options.method, url)));
  return relative ? `${url.pathname}${url.search}` : url.href;
}

/**
 * Whether `request` is the one its link was signed for and the link has not expired. A weak
 * secret throws; every other outcome is a verdict, so a caller decides what a refusal answers.
 */
export async function verifySignedLink(
  request: Request,
  options: VerifySignedLinkOptions,
): Promise<SignedLinkVerdict> {
  assertSecret(options.secret);
  const url = new URL(request.url);
  const signature = url.searchParams.get(SIGNATURE);
  const expires = url.searchParams.get(EXPIRES);
  if (signature === null) return { ok: false, reason: 'unsigned' };
  if (
    expires === null ||
    !EXPIRES_VALUE.test(expires) ||
    url.searchParams.getAll(SIGNATURE).length !== 1 ||
    url.searchParams.getAll(EXPIRES).length !== 1
  )
    return { ok: false, reason: 'malformed' };
  const expected = await hmac(options.secret, signedText(request.method, url));
  if (!secretsEqual(signature, expected)) return { ok: false, reason: 'forged' };
  const expiresAt = new Date(Number(expires) * 1000);
  const now = (options.now ?? (() => new Date()))();
  if (now.getTime() > expiresAt.getTime()) return { ok: false, reason: 'expired' };
  return { ok: true, expiresAt };
}
