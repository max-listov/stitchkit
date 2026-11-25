/**
 * Portable JSON response builder.
 *
 * `Response.json()` is absent in `whatwg-fetch` (used by React Native), so
 * every framework JSON response goes through this helper instead. Preserves
 * `JSON.stringify` failure semantics (BigInt, circular structures, `undefined`)
 * and does not overwrite a caller-supplied `content-type` header.
 */
export function jsonResponse(body: unknown, init?: ResponseInit): Response {
  const json = JSON.stringify(body);
  if (json === undefined) {
    throw new TypeError('Value is not JSON serializable');
  }
  const headers = new Headers(init?.headers);
  if (!headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  return new Response(json, { ...init, headers });
}
