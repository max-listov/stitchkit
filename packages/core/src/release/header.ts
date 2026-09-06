/**
 * The response header that names the frontend build the server considers
 * current. Set on every response of a handler configured with a release
 * marker — success, error, raw route — so a client learns about a release
 * from whatever it was already asking, with no socket and no polling of its
 * own. Exposed through CORS by default, like `X-Request-Id`.
 */
export const RELEASE_HEADER = 'X-Build-Id';
