/**
 * THE VARIANT: a browser that must reach the API role at a different origin.
 *
 * The default in this example is same-origin (`lib/api/client.ts`): the browser
 * calls `/api/…` and the web role forwards. Two things can pull a deployment
 * out of that, and they are separate, so they have separate variables:
 *
 * - **`PUBLIC_REALTIME_ORIGIN`** — the socket. A WebSocket upgrade does not
 *   survive a proxying route handler, so a deployment running the two roles on
 *   two ports with no routing layer in front of them must name the socket's
 *   origin even though its HTTP is already same-origin. This one is read by the
 *   default path, and unset means the page's own origin.
 * - **`PUBLIC_API_ORIGIN`** — HTTP. Only for a frontend that genuinely dials
 *   the API role itself: separate hostnames with nothing in front of them.
 *   Setting it changes nothing on its own; switching is an import, below.
 *
 * Switching HTTP to this variant is one line in `queries.ts`:
 *
 * ```ts
 * // before
 * import { repositoryApi } from './client'
 * fetcher: () => repositoryApi.read()
 * // after
 * import { repositoryApiCrossOrigin } from './cross-origin'
 * fetcher: () => repositoryApiCrossOrigin().read()
 * ```
 *
 * What that costs, in order:
 *
 * 1. **The address is a property of the place**, so it can never be compiled
 *    in. The server reads it per request and hands it to the browser
 *    (`providers/index.tsx` → `providers/client-providers.tsx`).
 * 2. **Nothing can be built at import time.** The client has to be constructed
 *    on FIRST USE — hence the parentheses, which the default path does not pay.
 * 3. **Order matters.** Anything reading the origin must render inside
 *    `<Providers>`; outside it, the value is not there yet.
 * 4. **The API role needs `CORS_ORIGIN`**, for HTTP and for the realtime
 *    handshake alike.
 *
 * None of that is wrong — it is the correct shape for the case. It is simply
 * not the case most projects have, which is why it is not the body of the
 * example.
 */
import { createRepositoryApi } from './client';

export interface PublicOrigins {
  /** Where the browser dials the API role over HTTP, if not this origin. */
  readonly api: string | undefined;
  /** Where the browser opens the realtime socket, if not this origin. */
  readonly realtime: string | undefined;
}

let origins: PublicOrigins = { api: undefined, realtime: undefined };

/** Supplied by the server, once, above every consumer. */
export function setPublicOrigins(supplied: PublicOrigins): void {
  origins = supplied;
}

/**
 * The socket's origin, or `undefined` when this deployment serves both roles on
 * one origin.
 *
 * `undefined` is an answer, not a missing value: the socket then connects to
 * the page's own origin, where a routing layer forwards `/socket.io`.
 */
export function optionalRealtimeOrigin(): string | undefined {
  return origins.realtime;
}

export function requirePublicApiOrigin(): string {
  const { api } = origins;
  if (!api) {
    throw new Error(
      'The public API origin has not been provided — set PUBLIC_API_ORIGIN and render this inside <Providers>, which supplies it from the server.',
    );
  }
  return api;
}

let crossOriginApi: ReturnType<typeof createRepositoryApi> | undefined;

/** Built on FIRST USE: the origin arrives at runtime, not at import. */
export function repositoryApiCrossOrigin(): ReturnType<typeof createRepositoryApi> {
  crossOriginApi ??= createRepositoryApi(requirePublicApiOrigin());
  return crossOriginApi;
}
