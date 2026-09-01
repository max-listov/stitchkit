/**
 * HTTP request helpers — header parsing, client identification, trace ids.
 * Pure `Request → value` functions; no framework state.
 */

import { isUnsafeKey } from '../internal/safe-json';
import { isRecord } from '../internal/typed';

/** Compact, time-sortable id — base36 timestamp + a cryptographic suffix. */
export function generateTraceId(): string {
  return `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Trace id for a request: a trusted inbound `x-request-id` / `x-trace-id`
 * header (set by the edge proxy) when present and sane, else a fresh one.
 * Shared by the router, the logger and any consumer that wants the same id.
 */
export function resolveTraceId(req: Request): string {
  const header = req.headers.get('x-request-id') ?? req.headers.get('x-trace-id');
  const trimmed = header?.trim();
  // Accept only a sane id — anything with CRLF or odd chars is rejected before
  // it is echoed into a response header or a log line (injection guard).
  if (trimmed && trimmed.length <= 128 && /^[\w.-]+$/.test(trimmed)) {
    return trimmed;
  }
  return generateTraceId();
}

/**
 * Resolve the real socket peer IP from the runtime — unspoofable, unlike a
 * header. On Bun the server resolves it (`server.requestIP`); on Node / Deno
 * the `srvx` adapter attaches `.ip` to the request. `undefined` when neither
 * is available (the bare `createHandler` fetch with no server).
 */
export function resolveSocketIp(req: Request, server: unknown): string | undefined {
  if (
    typeof server === 'object' &&
    server !== null &&
    'requestIP' in server &&
    typeof server.requestIP === 'function'
  ) {
    const addr: unknown = server.requestIP(req);
    if (isRecord(addr) && typeof addr.address === 'string' && addr.address) {
      return addr.address;
    }
  }
  // `srvx` (Node / Deno) attaches the client IP to the request object.
  if ('ip' in req && typeof req.ip === 'string' && req.ip) return req.ip;
  return undefined;
}

/** Options for `extractIp` / `getClientInfo`. */
export interface ClientIpOptions {
  /**
   * Trust `x-forwarded-for` / `x-real-ip` for the client IP. Enable only behind
   * a proxy that overwrites them — they are client-controllable. Default
   * `false`: the real socket IP (`socketIp`) is used instead.
   */
  trustProxy?: boolean;
  /** The real socket peer IP — see `resolveSocketIp`. */
  socketIp?: string;
}

/**
 * The client IP for a request. With `trustProxy`, the `x-forwarded-for` /
 * `x-real-ip` client wins (the server sits behind a proxy that rewrites them);
 * otherwise the real, unspoofable socket peer (`socketIp`) is used. Returns
 * `''` when nothing is known.
 */
export function extractIp(req: Request, options: ClientIpOptions = {}): string {
  if (options.trustProxy) {
    const forwarded = req.headers.get('x-forwarded-for');
    if (forwarded) return (forwarded.split(',')[0] ?? '').trim().replace(/^::ffff:/, '');
    const realIp = req.headers.get('x-real-ip');
    if (realIp) return realIp.trim().replace(/^::ffff:/, '');
  }
  return (options.socketIp ?? '').replace(/^::ffff:/, '');
}

/** Client identity — IP + user-agent. The one place projects derive both. */
export function getClientInfo(
  req: Request,
  options: ClientIpOptions = {},
): {
  ipAddress?: string;
  userAgent?: string;
} {
  return {
    ipAddress: extractIp(req, options) || undefined,
    userAgent: req.headers.get('user-agent') ?? undefined,
  };
}

/** Flatten a URL query string — repeated keys collapse to arrays. */
export function parseQueryParams(url: URL): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {};
  for (const key of new Set(url.searchParams.keys())) {
    // `?__proto__=x` would pollute the prototype chain on assignment.
    if (isUnsafeKey(key)) continue;
    const values = url.searchParams.getAll(key);
    const [first] = values;
    query[key] = values.length === 1 && first !== undefined ? first : values;
  }
  return query;
}

/**
 * IPv4 ranges that are never a public peer, as `[network, prefix bits]`.
 *
 * The list is IANA's special-purpose registry, not a memory of the three
 * "private" blocks: the ones that get forgotten are the ones that matter.
 * Carrier-grade NAT (`100.64/10`) is a real client address that no route
 * reaches back, and `169.254/16` is what a host answers with when DHCP failed.
 */
const IPV4_RESERVED: readonly (readonly [string, number])[] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

/** Dotted quad → 32-bit integer, or `undefined` when it is not one. */
function parseIpv4(value: string): number | undefined {
  const parts = value.split('.');
  if (parts.length !== 4) return undefined;
  let result = 0;
  for (const part of parts) {
    // A leading zero is read as octal by some resolvers and as decimal by
    // others, so `010.0.0.1` means two different hosts depending on who asks.
    // An address whose meaning depends on the reader is not one we affirm.
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return undefined;
    const octet = Number(part);
    if (octet > 255) return undefined;
    result = result * 256 + octet;
  }
  return result;
}

/** Full or compressed IPv6 → 16 bytes, or `undefined`. */
function parseIpv6(value: string): Uint8Array | undefined {
  // A zone index (`fe80::1%eth0`) names an interface, not a different address.
  const address = value.split('%')[0] ?? '';
  if (!address.includes(':')) return undefined;
  const halves = address.split('::');
  if (halves.length > 2) return undefined;
  const groups: number[] = [];
  const tail: number[] = [];
  const push = (into: number[], text: string): boolean => {
    if (text === '') return true;
    for (const piece of text.split(':')) {
      if (piece.includes('.')) {
        const v4 = parseIpv4(piece);
        if (v4 === undefined) return false;
        into.push((v4 >>> 16) & 0xffff, v4 & 0xffff);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return false;
      into.push(Number.parseInt(piece, 16));
    }
    return true;
  };
  if (!push(groups, halves[0] ?? '')) return undefined;
  if (halves.length === 2 && !push(tail, halves[1] ?? '')) return undefined;
  const missing = 8 - groups.length - tail.length;
  if (halves.length === 2 ? missing < 0 : missing !== 0) return undefined;
  const words = [
    ...groups,
    ...Array<number>(halves.length === 2 ? missing : 0).fill(0),
    ...tail,
  ];
  if (words.length !== 8) return undefined;
  const bytes = new Uint8Array(16);
  words.forEach((word, index) => {
    bytes[index * 2] = (word >>> 8) & 0xff;
    bytes[index * 2 + 1] = word & 0xff;
  });
  return bytes;
}

function hasPrefix(bytes: Uint8Array, prefix: readonly number[], bits: number): boolean {
  for (let index = 0; index < bits; index += 1) {
    const byte = bytes[index >> 3] ?? 0;
    const against = prefix[index >> 3] ?? 0;
    const mask = 0x80 >> (index % 8);
    if ((byte & mask) !== (against & mask)) return false;
  }
  return true;
}

/**
 * Whether an address belongs to the public internet.
 *
 * The question behind it is always the same one: *may this address be handed to
 * something outside this process* — resolved against a third party, fetched
 * from, recorded as where a request came from. A loopback, a private LAN
 * address, a carrier-NAT address or a link-local one answer no, each for its
 * own reason, and none of them identifies a host anyone else can reach.
 *
 * **Anything it cannot parse is not public.** An empty string, a hostname, a
 * truncated address: the honest answer to "is this a public peer" is no, and a
 * function that returned `true` for a value it did not understand would be
 * safe-by-accident exactly until the first malformed header.
 *
 * IPv4-mapped IPv6 (`::ffff:10.0.0.1`) is judged as the IPv4 address it
 * carries — the mapping is notation, not a different host. Pair it with
 * `extractIp`, which produces the value this asks about.
 */
export function isPublicIp(value: string): boolean {
  const address = value.trim();
  if (!address) return false;

  const v4 = parseIpv4(address);
  if (v4 !== undefined) {
    return !IPV4_RESERVED.some(([network, bits]) => {
      const base = parseIpv4(network);
      if (base === undefined) return false;
      // `>>> 0` keeps the shift unsigned: a /1..8 mask has the sign bit set,
      // and a signed compare would read `240.0.0.0/4` as negative.
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      return (v4 & mask) >>> 0 === (base & mask) >>> 0;
    });
  }

  const bytes = parseIpv6(address);
  if (!bytes) return false;
  // IPv4-mapped: the last four bytes are the real address and answer for it.
  if (hasPrefix(bytes, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff], 96)) {
    return isPublicIp(Array.from(bytes.slice(12)).join('.'));
  }
  // IPv6 states the rule the other way round: exactly one block, `2000::/3`, is
  // global unicast, and everything else — loopback, unique-local, link-local,
  // multicast, the discard prefix — is outside it by construction. Enumerating
  // the exclusions the way IPv4 forces would be a list that ages; this one
  // cannot miss a range that has not been assigned yet.
  if (!hasPrefix(bytes, [0x20], 3)) return false;
  if (hasPrefix(bytes, [0x20, 0x01, 0x00, 0x00], 23)) return false; // IETF assignments
  if (hasPrefix(bytes, [0x20, 0x01, 0x0d, 0xb8], 32)) return false; // documentation
  return true;
}
