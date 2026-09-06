/**
 * Send a body from a document that is being unloaded.
 *
 * The body is a **string**, so the request goes out as `text/plain` — a
 * CORS-safelisted media type that needs no preflight, which is the only kind
 * of request a dying document can still complete against another origin. A
 * `Blob` typed `application/json` reports `true` and never arrives (ADR 0165).
 * The receiving endpoint declares `safelistedBody: true`.
 *
 * `sendBeacon` sends no headers, so a bearer-authenticated application puts
 * its identity in the body. Returns `false` where the API is missing.
 */
export function sendUnloadBeacon(
  url: string,
  body: string,
  sender: Pick<Navigator, 'sendBeacon'> | undefined = typeof navigator === 'undefined'
    ? undefined
    : navigator,
): boolean {
  if (!sender || typeof sender.sendBeacon !== 'function') return false;
  return sender.sendBeacon(url, body);
}
