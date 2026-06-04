/**
 * Where a method's input travels over HTTP — the single source of truth for the
 * convention shared by the typed client (what it SENDS) and the OpenAPI
 * generator (what it DOCUMENTS), so the two cannot drift. GET and DELETE carry
 * their input as query parameters; the body verbs (POST / PUT / PATCH) carry it
 * as a request body.
 *
 * The server runtime is a tolerant superset of this: it additionally accepts a
 * DELETE *body* when the request carries an `application/json` content-type. The
 * canonical form a client uses and the spec documents is the query form.
 */
export function inputIsQuery(method: string): boolean {
  return method === 'GET' || method === 'DELETE';
}
