/**
 * SSRF-guarded fetch + size-capped body read — the shared security boundary for
 * every model/handler-controlled URL the framework fetches (`view_file`,
 * `mountDownload`, the CLI `--output-dir` downloader). It refuses non-`http(s)`
 * schemes (so a redirect to `file://` cannot turn into a local-file read),
 * private / internal / numeric-disguised hosts, and re-validates on EVERY
 * redirect hop; bodies are read with a hard byte cap so a hostile or accidental
 * multi-GB / unbounded stream cannot OOM the process.
 *
 * Node-side only (uses `node:dns` / `node:net`) — never import from a
 * browser-safe entrypoint.
 */
import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

/** A host that is digits/dots-only or `0x…` is a numeric IP in disguise. */
const NUMERIC_HOST = /^(0x[0-9a-f]+|[0-9.]+)$/i;

/** Cap on redirect hops the SSRF guard re-validates before giving up. */
const MAX_REDIRECTS = 5;

function assertHttpUrl(url: URL): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`refusing to fetch a non-http(s) URL (${url.protocol})`);
  }
}

function mappedIpv4FromIpv6(ip: string): string | null {
  const rest = ip.startsWith('::ffff:')
    ? ip.slice('::ffff:'.length)
    : ip.startsWith('0:0:0:0:0:ffff:')
      ? ip.slice('0:0:0:0:0:ffff:'.length)
      : null;
  if (rest === null) return null;

  if (isIP(rest) === 4) return rest;

  const [hiRaw, loRaw, extra] = rest.split(':');
  if (hiRaw === undefined || loRaw === undefined || extra !== undefined) return null;
  if (!/^[0-9a-f]{1,4}$/i.test(hiRaw) || !/^[0-9a-f]{1,4}$/i.test(loRaw)) return null;

  const hi = Number.parseInt(hiRaw, 16);
  const lo = Number.parseInt(loRaw, 16);
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.');
}

function ipv6Words(ip: string): number[] | null {
  const halves = ip.toLowerCase().split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const parts = halves.length === 2 ? [...head, ...Array(missing).fill('0'), ...tail] : head;
  if (parts.length !== 8) return null;
  const words: number[] = [];
  for (const part of parts) {
    if (!/^[0-9a-f]{1,4}$/i.test(part)) return null;
    words.push(Number.parseInt(part, 16));
  }
  return words;
}

/** True unless the literal belongs to the globally routable unicast Internet. */
export function isPrivateIp(ip: string): boolean {
  const normalized = ip.replace(/^\[|\]$/g, '');
  const family = isIP(normalized);
  if (family === 4) {
    const [a, b] = normalized.split('.').map(Number);
    if (a === undefined || b === undefined) return true;
    const value = normalized
      .split('.')
      .map(Number)
      .reduce((total, octet) => total * 256 + octet, 0);
    const inCidr = (base: string, prefix: number): boolean => {
      const baseValue = base
        .split('.')
        .map(Number)
        .reduce((total, octet) => total * 256 + octet, 0);
      const size = 2 ** (32 - prefix);
      return value >= baseValue && value < baseValue + size;
    };
    const blockedRanges: Array<[string, number]> = [
      ['0.0.0.0', 8],
      ['10.0.0.0', 8],
      ['100.64.0.0', 10],
      ['127.0.0.0', 8],
      ['169.254.0.0', 16],
      ['172.16.0.0', 12],
      ['192.0.0.0', 24],
      ['192.0.2.0', 24],
      ['192.31.196.0', 24],
      ['192.52.193.0', 24],
      ['192.88.99.0', 24],
      ['192.168.0.0', 16],
      ['192.175.48.0', 24],
      ['198.18.0.0', 15],
      ['198.51.100.0', 24],
      ['203.0.113.0', 24],
      ['224.0.0.0', 4],
      ['240.0.0.0', 4],
    ];
    return blockedRanges.some(([base, prefix]) => inCidr(base, prefix));
  }
  if (family === 6) {
    const lower = normalized.toLowerCase();
    const mapped = mappedIpv4FromIpv6(lower);
    if (mapped) return isPrivateIp(mapped);
    const words = ipv6Words(lower);
    if (!words) return true;
    const [first, second, third] = words;
    if (first === undefined || second === undefined || third === undefined) return true;
    return (
      first === 0 ||
      (first === 0x64 && second === 0xff9b && third === 1) ||
      (first === 0x100 && second === 0) ||
      (first === 0x2001 && (second <= 0x01ff || second === 0x0db8)) ||
      first === 0x2002 ||
      first === 0x3fff ||
      first === 0x5f00 ||
      (first & 0xfe00) === 0xfc00 ||
      (first & 0xffc0) === 0xfe80 ||
      (first & 0xff00) === 0xff00
    );
  }
  return false;
}

/**
 * Refuse a URL that is not `http(s)`, has no host, or whose host is — or
 * resolves to — a private/internal address. Called on the initial URL and on
 * every redirect hop, so a public host cannot `302` to an internal address or
 * to a `file:` / `gopher:` / `data:` scheme.
 */
export async function assertPublicUrl(url: URL): Promise<void> {
  // Scheme allowlist first — a redirect `Location: file:///etc/passwd` adopts a
  // new protocol, and an empty-host `file:` URL would otherwise slip the
  // host checks (an empty DNS lookup resolves to nothing, not a private IP).
  assertHttpUrl(url);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host) throw new Error('refusing to fetch a URL with no host');
  if (isIP(host)) {
    if (isPrivateIp(host)) throw new Error('refusing to fetch a private address');
    return;
  }
  // A digits-only / `0x…` host is a numeric IP in a non-canonical form
  // (`http://2130706433/` is `127.0.0.1`); `isIP` rejects it but `fetch`
  // would still resolve it. A real hostname always carries a non-numeric char.
  if (NUMERIC_HOST.test(host)) {
    throw new Error('refusing to fetch a non-canonical numeric host');
  }
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('refusing to fetch an internal host');
  }
  const records = await lookup(host, { all: true });
  for (const record of records) {
    if (isPrivateIp(record.address)) {
      throw new Error('refusing to fetch a host that resolves to a private address');
    }
  }
}

/**
 * Fetch a URL with the SSRF guard enforced on the initial URL and on every
 * redirect hop — a public host can otherwise `302` to an internal address or a
 * non-http(s) scheme.
 *
 * Note: the DNS resolution here and the resolution `fetch` performs are
 * separate, so a hostile resolver retains a narrow rebinding window. The
 * per-hop re-check is the larger and fully-closed hole; a static private DNS
 * record is rejected outright.
 */
export async function fetchGuarded(start: URL, allowPrivate: boolean): Promise<Response> {
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (allowPrivate) assertHttpUrl(url);
    else await assertPublicUrl(url);
    const res = await fetch(url, { redirect: 'manual' });
    if (res.status < 300 || res.status >= 400) return res;
    const location = res.headers.get('location');
    if (!location) return res;
    await res.body?.cancel();
    url = new URL(location, url);
  }
  throw new Error('too many redirects');
}

export interface PinnedDocumentFetchOptions {
  maxBytes: number;
  timeoutMs: number;
  maxRedirects?: number;
  headers?: Record<string, string>;
  /** Require TLS on the initial URL and every redirect hop. */
  requireHttps?: boolean;
}

export interface PinnedDocumentResponse {
  status: number;
  headers: Headers;
  body: Uint8Array;
  url: URL;
}

async function resolvePublicAddress(
  url: URL,
  signal: AbortSignal,
): Promise<{ address: string; family: 4 | 6 }> {
  assertHttpUrl(url);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host) throw new Error('refusing to fetch a URL with no host');
  const ipFamily = isIP(host);
  if (ipFamily) {
    if (isPrivateIp(host)) throw new Error('refusing to fetch a private address');
    return { address: host, family: ipFamily === 6 ? 6 : 4 };
  }
  if (NUMERIC_HOST.test(host)) {
    throw new Error('refusing to fetch a non-canonical numeric host');
  }
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('refusing to fetch an internal host');
  }
  const records = await Promise.race([
    lookup(host, { all: true }),
    new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  ]);
  for (const record of records) {
    if (isPrivateIp(record.address)) {
      throw new Error('refusing to fetch a host that resolves to a private address');
    }
  }
  const record = records[0];
  if (!record) throw new Error('public hostname resolved to no addresses');
  return { address: record.address, family: record.family === 6 ? 6 : 4 };
}

/**
 * Fetch a small public document while pinning the TCP connection to the exact
 * public DNS answer that passed validation. This closes the check/use DNS
 * rebinding gap that a separate `lookup()` followed by global `fetch()` leaves.
 */
export async function fetchPinnedDocument(
  start: URL,
  options: PinnedDocumentFetchOptions,
): Promise<PinnedDocumentResponse> {
  if (!Number.isInteger(options.maxBytes) || options.maxBytes < 1) {
    throw new Error('maxBytes must be a positive integer');
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error('timeoutMs must be positive');
  }
  let url = start;
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0) {
    throw new Error('maxRedirects must be a non-negative integer');
  }
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const signal = AbortSignal.timeout(options.timeoutMs);
    if (options.requireHttps && url.protocol !== 'https:') {
      throw new Error('document URL and every redirect must use https');
    }
    if (url.username || url.password) {
      throw new Error('document URL cannot contain credentials');
    }
    const resolved = await resolvePublicAddress(url, signal);
    const transport = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const response = await new Promise<PinnedDocumentResponse>((resolve, reject) => {
      const request = transport(
        {
          protocol: url.protocol,
          hostname: resolved.address,
          family: resolved.family,
          port: url.port || undefined,
          path: `${url.pathname}${url.search}`,
          method: 'GET',
          signal,
          servername: url.hostname,
          headers: {
            host: url.host,
            accept: 'application/json',
            ...options.headers,
          },
        },
        (incoming) => {
          const headers = new Headers();
          for (const [name, value] of Object.entries(incoming.headers)) {
            if (Array.isArray(value)) {
              for (const item of value) headers.append(name, item);
            } else if (value !== undefined) {
              headers.set(name, value);
            }
          }
          const chunks: Uint8Array[] = [];
          let total = 0;
          incoming.on('data', (chunk: Uint8Array) => {
            total += chunk.byteLength;
            if (total > options.maxBytes) {
              incoming.destroy(new Error('response body exceeds configured byte limit'));
              return;
            }
            chunks.push(chunk);
          });
          incoming.once('error', reject);
          incoming.once('end', () => {
            const body = new Uint8Array(total);
            let offset = 0;
            for (const chunk of chunks) {
              body.set(chunk, offset);
              offset += chunk.byteLength;
            }
            resolve({ status: incoming.statusCode ?? 0, headers, body, url });
          });
        },
      );
      request.once('error', reject);
      request.end();
    });

    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get('location');
    if (!location) return response;
    url = new URL(location, url);
  }
  throw new Error('too many redirects');
}

/**
 * Read a response body into a buffer, aborting (and returning `null`) if it
 * exceeds `max` bytes — the size cap that keeps a hostile or unbounded stream
 * from OOM-ing the process. A missing body yields an empty buffer.
 */
export async function readCapped(res: Response, max: number): Promise<Buffer | null> {
  const reader = res.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > max) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}
