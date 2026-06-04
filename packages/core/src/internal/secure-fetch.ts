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

/** True for a loopback / private / link-local / ULA / CGNAT IP literal. */
export function isPrivateIp(ip: string): boolean {
  const normalized = ip.replace(/^\[|\]$/g, '');
  const family = isIP(normalized);
  if (family === 4) {
    const [a, b] = normalized.split('.').map(Number);
    if (a === undefined || b === undefined) return true;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (family === 6) {
    const lower = normalized.toLowerCase();
    const mapped = mappedIpv4FromIpv6(lower);
    if (mapped) return isPrivateIp(mapped);
    if (lower === '::1' || lower === '::') return true;
    if (
      lower.startsWith('fe8') ||
      lower.startsWith('fe9') ||
      lower.startsWith('fea') ||
      lower.startsWith('feb') ||
      lower.startsWith('fc') ||
      lower.startsWith('fd')
    ) {
      return true;
    }
    return false;
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
