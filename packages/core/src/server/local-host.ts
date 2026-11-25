/**
 * A server that answers one machine's own windows, and nobody else.
 *
 * An app host — the process beside a desktop window — is an ordinary Stitchkit
 * server bound to loopback. Binding to loopback keeps other machines out; it
 * does not keep out a web page open in a browser on the same machine, which can
 * reach `http://127.0.0.1:<port>` and open a WebSocket to it (a WebSocket obeys
 * no CORS), nor a DNS-rebinding page that names the host by an attacker's
 * domain. The guard closes both: every request must name a loopback `Host`,
 * carry an allowed `Origin` when it carries one, and present the host's secret.
 * The same three checks gate the Socket.IO handshake, so events reach only the
 * windows the requests do.
 */
import { z } from 'zod';
import { forbidden, unauthorized } from '../contract/errors';
import { secretsEqual } from '../internal/secret-equal';
import { errorResponse } from './raw';
import type { SocketIOHandshakeConfig, SocketIORequestPolicy } from './socket-io-config';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Configuration for `createLocalHostGuard` enforcing loopback host, origin, and bearer secret. */
export interface LocalHostGuardConfig {
  /**
   * What every window presents: `Authorization: Bearer <secret>` on a request,
   * `auth: { secret }` in the Socket.IO handshake. Compared in constant time.
   * At least 16 characters — generate it per host start, never put it in a URL.
   */
  secret: string;
  /**
   * The exact origins a browser-hosted window runs at, e.g. `tauri://localhost`.
   * A request that carries an `Origin` outside this list is refused; one with no
   * `Origin` (a native client) passes this check. Pass `[]` for a native-only
   * host; `guard.cors` is then `undefined`.
   */
  origins: readonly string[];
}

/** Why the guard refused a request, without the secret. */
export type LocalHostRefusal = 'host-not-loopback' | 'origin-not-allowed' | 'secret-mismatch';

/** Loopback HTTP and Socket.IO request guard returned by `createLocalHostGuard`. */
export interface LocalHostGuard {
  /** The first rule this request breaks, or `undefined` when it may be served. */
  check(request: Request): LocalHostRefusal | undefined;
  /** `hooks.onRequest`: refuses every route, raw ones included, before routing. */
  onRequest(request: Request): Response | undefined;
  /** Socket.IO `allowRequest`: the `Host` and `Origin` rules, before the upgrade. */
  allowRequest: SocketIORequestPolicy;
  /** Socket.IO `handshake`: the secret, as `auth: { secret }`. */
  handshake: SocketIOHandshakeConfig<{ secret: string }, { localHost: true }>;
  /**
   * `cors` for the server and the socket: the same origins, no credentials, or
   * `undefined` when `origins` is empty (a native-only host that emits no CORS
   * headers). A window in a webview is a cross-origin page — without it the
   * browser blocks its preflight (answered before `onRequest`) and every response.
   */
  cors: { origin: string[]; credentials: false } | undefined;
}

function hostName(request: Request): string | undefined {
  const host = request.headers.get('host');
  if (host === null) return undefined;
  // `[::1]:3000`, `127.0.0.1:3000`, `localhost` — the port is not the host.
  const bracketed = /^(\[[^\]]+\])(?::\d+)?$/.exec(host);
  if (bracketed) return bracketed[1];
  return host.replace(/:\d+$/, '').toLowerCase();
}

/** Create a loopback host, origin, and constant-time secret guard for local app hosts. */
export function createLocalHostGuard(config: LocalHostGuardConfig): LocalHostGuard {
  if (config.secret.length < 16)
    throw new TypeError('createLocalHostGuard requires a secret of at least 16 characters');
  const origins = new Set(config.origins);

  const placeAndOrigin = (request: Request): LocalHostRefusal | undefined => {
    const host = hostName(request);
    if (host === undefined || !LOOPBACK_HOSTS.has(host)) return 'host-not-loopback';
    const origin = request.headers.get('origin');
    if (origin !== null && !origins.has(origin)) return 'origin-not-allowed';
    return undefined;
  };

  const check = (request: Request): LocalHostRefusal | undefined => {
    const refusal = placeAndOrigin(request);
    if (refusal) return refusal;
    const authorization = request.headers.get('authorization') ?? '';
    // The scheme is case-insensitive (RFC 9110); the secret is not.
    const presented = /^bearer /i.test(authorization) ? authorization.slice(7) : '';
    return secretsEqual(presented, config.secret) ? undefined : 'secret-mismatch';
  };

  const refuse = (refusal: LocalHostRefusal): Response => {
    try {
      return refusal === 'secret-mismatch'
        ? unauthorized('This host serves its own windows only')
        : forbidden(
            refusal === 'host-not-loopback'
              ? 'This host answers only on a loopback address'
              : 'This origin may not call this host',
          );
    } catch (error) {
      return errorResponse(error);
    }
  };

  return {
    check,
    onRequest(request) {
      const refusal = check(request);
      return refusal ? refuse(refusal) : undefined;
    },
    allowRequest: (request) => placeAndOrigin(request) === undefined,
    cors: origins.size > 0 ? { origin: [...origins], credentials: false } : undefined,
    handshake: {
      schema: z.object({ secret: z.string() }),
      verify: ({ secret }) =>
        secretsEqual(secret, config.secret) ? { localHost: true } : null,
    },
  };
}
