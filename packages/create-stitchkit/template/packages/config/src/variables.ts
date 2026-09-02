import { z } from 'zod';
import { featureServerSchema } from './features';

/**
 * Every environment variable this application reads, declared **once**.
 *
 * There used to be three overlapping copies — the server schema, the frontend
 * schema and the tooling schema — and they had already drifted in composition.
 * A fourth copy in the project declaration would have been worse still, so this
 * module is the source and everything else is a projection of it:
 *
 * - `server.ts` validates all of them for the API role;
 * - `frontend/src/env.ts` projects the handful the web role reads;
 * - `scripts/declaration.ts` DERIVES `env.required` in `project.json` from
 *   here, so the declaration a deployment reads can never fall behind.
 *
 * Defaults, coercion and error messages live here and only here. The
 * declaration carries names and shapes; it deliberately carries no values.
 */
const baseVariables = {
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.url(),
  // Loopback by default — exposing the app to the network is an explicit
  // opt-in (`BIND_HOST=0.0.0.0`), never something a forgotten edit causes.
  BIND_HOST: z.string().min(1).default('127.0.0.1'),
  API_PORT: z.coerce.number().int().positive(),
  WEB_PORT: z.coerce.number().int().positive(),
  /**
   * Override for the public origin of the web role, for a proxy that forwards
   * neither `x-forwarded-host` nor a usable `Host`. Normally unset: the origin
   * comes from the request, which is what lets one artifact serve many
   * addresses.
   */
  PUBLIC_WEB_ORIGIN: z.url().optional(),
  /**
   * Which hosts this deployment answers for, comma-separated, when more than
   * one address reaches the same artifact. Unset means only PUBLIC_WEB_ORIGIN;
   * a forwarded host outside the list is refused rather than believed.
   */
  PUBLIC_WEB_HOSTS: z.string().min(1).optional(),
  /**
   * Where the web role reaches the API role, server side. Never seen by a
   * browser. The blank starter needs it only if it calls the API at all.
   */
  INTERNAL_API_URL: z.url().optional(),
  /**
   * Where the BROWSER dials the API role over HTTP, when it must dial it
   * directly instead of reaching it through its own origin.
   *
   * Set it only for a genuinely cross-origin frontend. It affects HTTP and
   * nothing else — the realtime socket has its own variable below, because the
   * two answers differ: HTTP can be forwarded by the web role, and a WebSocket
   * upgrade cannot.
   */
  PUBLIC_API_ORIGIN: z.url().optional(),
  /**
   * Where the browser opens the realtime socket, when the two roles do not
   * share an origin.
   *
   * Separate from `PUBLIC_API_ORIGIN` on purpose. A WebSocket upgrade does not
   * survive a proxying route handler, so a deployment can serve HTTP from one
   * origin and still need to name the socket's — which is exactly the shape of
   * running the two roles on two ports with no routing layer in front of them.
   * Unset means the page's own origin, where a routing layer forwards
   * `/socket.io` to the API role.
   */
  PUBLIC_REALTIME_ORIGIN: z.url().optional(),
  LOG_FORMAT: z.enum(['pretty', 'json']).default('pretty'),
  /**
   * The browser origin the API role admits, for HTTP and for the realtime
   * handshake alike. Only a genuinely cross-origin browser needs it: a frontend
   * reaching the API through its own origin makes same-origin requests, and
   * requiring an origin there would be requiring knowledge of the place.
   */
  CORS_ORIGIN: z.url().optional(),
  /**
   * Where the board keeps its notes. A file, so they survive a restart — which
   * is the only thing that makes the board worth watching rather than a toy.
   */
  BOARD_STORE_PATH: z.string().min(1).default('.data/board.sqlite'),
  /**
   * The authorities this API answers on, comma-separated — `host` or
   * `host:port`.
   *
   * Set it and the trust fence is installed on BOTH lanes: HTTP before routing,
   * and the realtime handshake, which never reaches a lifecycle hook on either
   * runtime. Unset and there is no fence, which is honest for a local checkout
   * and wrong for anything reachable from a network — a fence cannot invent the
   * list of names it should answer to.
   */
  TRUSTED_HOSTS: z.string().min(1).optional(),
};

/**
 * The base declaration, then whatever this project's own features say.
 *
 * A merge rather than a spread inside one literal, so an overlay can **tighten**
 * a variable the base declares optional — not only add new ones. Without that,
 * a project whose code dereferences a variable without a fallback had no way to
 * say so, and its declaration told a deployment the variable was optional while
 * the first render threw.
 */
export const applicationVariables = { ...baseVariables, ...featureServerSchema };

export type ApplicationVariable = keyof typeof applicationVariables;
