/**
 * A trust fence by authority, not by port.
 *
 * A server bound to a private network is reachable by anything that can resolve
 * a name to its address — which is what makes DNS rebinding work: a page served
 * from an attacker's origin re-resolves that name to `127.0.0.1` and then talks
 * to the local server *same-origin*, so CORS never enters the picture and no
 * preflight is ever sent. The only thing that separates that request from a
 * legitimate one is the authority it addressed, and the only way to use it is to
 * compare it against a list of authorities that were expected.
 *
 * This is not CORS and does not replace it. CORS tells a browser what a *page*
 * may read across origins; the fence tells the server which authority it agreed
 * to answer on. A server can want both, and a server that only sets CORS is
 * unfenced against the attack above.
 *
 * ## What it fences, and what it does not
 *
 * Two lanes, because the framework has two and they do not share an entry:
 *
 * - **HTTP** — `hooks.onRequest`, which runs before routing, so a refusal costs
 *   no dispatch, no handler and no auth rule.
 * - **Socket.IO** — `allowRequest`, the engine's own admission policy. This is
 *   not a nicety: `/socket.io/*` never reaches `hooks.onRequest` on either
 *   runtime. On Bun the fetch handler answers it before the contract handler
 *   exists; on Node `socket.attach` gives the upgrade to Socket.IO directly. A
 *   fence installed only in `hooks` leaves every socket lane open, which is the
 *   half a live application actually pushes data over.
 *
 * Two things it deliberately does not do:
 *
 * - **It does not gate operations.** "Only from this machine" is a property of
 *   an operation, and operations are known after routing, not before it. Express
 *   it as an auth rule over `ctx.ipAddress` — {@link isLoopbackAddress} is here
 *   for exactly that — so it composes with every other rule and commits in the
 *   same transaction instead of becoming a second, invisible authorization
 *   registry.
 * - **It does not re-check an open connection.** Both lanes check at admission.
 *   A WebSocket that passed stays open on its own terms.
 *
 * One more asymmetry worth knowing: with `cors` configured, an `OPTIONS`
 * preflight is answered before `onRequest`, so the fence does not see it. That
 * preflight carries no operation and no body, and the attack this fence is for
 * never sends one — but a reader should know the fence's HTTP lane starts at the
 * request, not at its preflight.
 *
 * → ADR 0151.
 */
import type { StitchLogger } from '../../logger';
import type { SocketIORequestPolicy } from '../socket-io-config';
import type { LifecycleHooks } from '../types';

/** Which admission point refused. */
export type TrustLane = 'http' | 'socket';

export type TrustRefusalReason =
  /** No `Host` header at all — nothing to compare, so nothing to trust. */
  | 'missing-host'
  /** A `Host` that is not in the list, or is not a readable authority. */
  | 'untrusted-host'
  /** An `Origin` that disagrees with the `Host` it was sent to. */
  | 'origin-mismatch'
  /** The browser said this request came from another site. */
  | 'cross-site';

export interface TrustRefusal {
  readonly reason: TrustRefusalReason;
  readonly lane: TrustLane;
  /** Exactly what arrived, for the log — `null` when the header was absent. */
  readonly host: string | null;
  readonly origin: string | null;
  readonly site: string | null;
}

export interface TrustFenceConfig {
  /**
   * The authorities this server answers on: `host` or `host:port`.
   *
   * An entry without a port trusts that host on **any** port; with a port, only
   * that one. Compared after WHATWG normalisation on both sides, so
   * `LOCALHOST`, `localhost` and an IDN and its punycode are one entry — and
   * comparison is exact, never a prefix or a pattern. A port alone is not an
   * authority: matching by port is what leaves a server open to every host that
   * resolves to it, which is the arrangement this exists to replace.
   *
   * There is no implicit loopback entry. Trusting `localhost` because it looks
   * harmless would be the fence widening itself for a case nobody wrote down;
   * list it when you want it.
   */
  readonly trustedHosts: readonly string[];
  /** Called on every refusal, before the 403 is written. */
  readonly onRefused?: (refusal: TrustRefusal) => void;
  /** Refusals are logged at `warn` when a logger is supplied. */
  readonly logger?: StitchLogger;
}

export interface TrustFence {
  /**
   * Compose into the server's hooks — `composeLifecycleHooks(fence.hooks, …)`.
   *
   * Order matters and the fence has to be first: `composeLifecycleHooks` stops
   * at the first hook that answers, so a fence placed after a hook that returns
   * a `Response` never runs for those requests.
   */
  readonly hooks: Pick<LifecycleHooks, 'onRequest'>;
  /** Pass as `socket.allowRequest` — the Socket.IO lane's only admission point. */
  readonly allowRequest: SocketIORequestPolicy;
  /** The decision itself: the refusal, or `undefined` when the request is trusted. */
  check(request: Request, lane: TrustLane): TrustRefusal | undefined;
}

interface Authority {
  /** WHATWG-normalised host, lowercased, IDN and IPv6 canonical. */
  readonly hostname: string;
  /** As written; `null` means "any port" for an entry, "unstated" for a request. */
  readonly port: string | null;
}

/** Ports a URL of that scheme omits, so `example.com:443` and `example.com` compare equal. */
const DEFAULT_PORTS = new Set(['80', '443']);

/**
 * Read `host[:port]` through the URL parser.
 *
 * The port is split off first, by hand, because the parser *drops* a default
 * one: `new URL('http://example.com:80').host` is `example.com`, so a list entry
 * of `example.com:80` would silently widen to "any port" — a fence entry meaning
 * more than it says. Everything else — case, IDN, IPv6 brackets — is left to the
 * parser, which is the whole reason to use it.
 */
function readAuthority(value: string): Authority | undefined {
  // A wildcard is refused rather than treated as a literal host. The URL
  // parser accepts `*` in a hostname, so `*.example.com` would parse, match
  // nothing, and leave the operator believing a subtree was trusted.
  if (value.includes('*')) return undefined;
  const match = /^(\[[^\]]+\]|[^:[\]]+)(?::(\d{1,5}))?$/.exec(value.trim());
  if (!match?.[1]) return undefined;
  const port = match[2] ?? null;
  if (port !== null) {
    const numeric = Number(port);
    if (numeric < 1 || numeric > 65_535) return undefined;
  }
  let url: URL;
  try {
    url = new URL(`http://${match[1]}`);
  } catch {
    return undefined;
  }
  // A parse that succeeded but consumed more than an authority — a path, a
  // query, credentials — means the caller wrote something that is not one.
  if (
    url.pathname !== '/' ||
    url.search !== '' ||
    url.username !== '' ||
    url.hostname === ''
  ) {
    return undefined;
  }
  return { hostname: url.hostname, port };
}

/** `null` and a default port are the same thing when comparing two authorities. */
function comparablePort(port: string | null): string | null {
  return port === null || DEFAULT_PORTS.has(port) ? null : port;
}

/**
 * Whether an address is this machine talking to itself.
 *
 * For the auth rule that a privileged operation belongs to — `scope`-gated over
 * `ctx.ipAddress` — not for the fence, which compares authorities. An empty
 * string is what `extractIp` returns when the runtime could not tell it, and
 * "not known" is answered `false` here: an unknown peer is not a local one.
 */
export function isLoopbackAddress(address: string): boolean {
  if (address === '') return false;
  const bare = address.replace(/^\[|\]$/g, '').replace(/^::ffff:/i, '');
  if (bare === '::1') return true;
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(bare);
  return octets?.[1] === '127';
}

export function createTrustFence(config: TrustFenceConfig): TrustFence {
  if (config.trustedHosts.length === 0) {
    throw new Error(
      '[stitchkit] trust fence: `trustedHosts` cannot be empty — a fence that trusts nothing refuses every request, which is never what a running server wants. List the authorities this server answers on.',
    );
  }
  const trusted: Authority[] = [];
  for (const entry of config.trustedHosts) {
    const authority = readAuthority(entry);
    if (!authority) {
      throw new Error(
        `[stitchkit] trust fence: "${entry}" is not an authority. An entry is \`host\` or \`host:port\` — no scheme, no path, no credentials, no wildcard. An entry that cannot be read back as a canonical authority is refused here rather than quietly matching nothing.`,
      );
    }
    trusted.push(authority);
  }

  function refuse(refusal: TrustRefusal): TrustRefusal {
    config.onRefused?.(refusal);
    config.logger?.warn?.('[stitchkit] trust fence refused a request', {
      reason: refusal.reason,
      lane: refusal.lane,
      host: refusal.host,
      origin: refusal.origin,
    });
    return refusal;
  }

  function check(request: Request, lane: TrustLane): TrustRefusal | undefined {
    // The **header**, deliberately, not `new URL(request.url).host`. The Node
    // Socket.IO lane synthesises its `Request` from raw headers and falls back
    // to `localhost` when `Host` is absent — reading the URL there would turn a
    // missing header into the most trusted authority there is. The headers
    // travel verbatim; the URL does not.
    const host = request.headers.get('host');
    const origin = request.headers.get('origin');
    const site = request.headers.get('sec-fetch-site');

    if (host === null) {
      return refuse({ reason: 'missing-host', lane, host, origin, site });
    }
    const requested = readAuthority(host);
    if (!requested) {
      return refuse({ reason: 'untrusted-host', lane, host, origin, site });
    }
    const matched = trusted.some(
      (entry) =>
        entry.hostname === requested.hostname &&
        (entry.port === null || entry.port === requested.port),
    );
    if (!matched) {
      return refuse({ reason: 'untrusted-host', lane, host, origin, site });
    }
    if (site === 'cross-site') {
      return refuse({ reason: 'cross-site', lane, host, origin, site });
    }
    // `Origin: null` is a sandboxed or opaque origin. It states no authority, so
    // there is nothing to compare it against — it is neither a match nor a
    // mismatch, and treating it as either would be inventing a fact.
    if (origin !== null && origin !== 'null') {
      let originAuthority: Authority | undefined;
      try {
        const parsed = new URL(origin);
        originAuthority = { hostname: parsed.hostname, port: parsed.port || null };
      } catch {
        originAuthority = undefined;
      }
      const agrees =
        originAuthority !== undefined &&
        originAuthority.hostname === requested.hostname &&
        comparablePort(originAuthority.port) === comparablePort(requested.port);
      if (!agrees) {
        return refuse({ reason: 'origin-mismatch', lane, host, origin, site });
      }
    }
    return undefined;
  }

  return {
    hooks: {
      onRequest: (request) =>
        check(request, 'http') === undefined
          ? undefined
          : // One response for every reason. A refusal that says *why* is a probe
            // oracle: it lets a caller learn the trusted list one guess at a time.
            // The reason goes to `onRefused` and the log, where the operator is.
            new Response(null, { status: 403 }),
    },
    allowRequest: (request) => check(request, 'socket') === undefined,
    check,
  };
}
