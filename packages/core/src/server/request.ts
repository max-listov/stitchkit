/**
 * HTTP request helpers — header parsing, client identification, trace ids.
 * Pure `Request → value` functions; no framework state.
 */

/** Compact, time-sortable id — base36 timestamp + base36 random, ~14 chars. */
export function generateTraceId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
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

/** Client IP from `x-forwarded-for` / `x-real-ip` (IPv4-mapped prefix stripped). */
export function extractIp(req: Request): string {
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) return (forwarded.split(',')[0] ?? '').trim().replace('::ffff:', '');
  const realIp = req.headers.get('x-real-ip');
  if (realIp) return realIp.trim().replace('::ffff:', '');
  return '';
}

/** Client identity — IP + user-agent. The one place projects derive both. */
export function getClientInfo(req: Request): {
  ipAddress?: string;
  userAgent?: string;
} {
  return {
    ipAddress: extractIp(req) || undefined,
    userAgent: req.headers.get('user-agent') ?? undefined,
  };
}

/** Flatten a URL query string — repeated keys collapse to arrays. */
export function parseQueryParams(url: URL): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {};
  for (const key of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(key);
    const [first] = values;
    query[key] = values.length === 1 && first !== undefined ? first : values;
  }
  return query;
}
