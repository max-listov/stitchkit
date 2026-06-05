/**
 * Range-capable file serving — RFC 7233 (`206` / `416` / `Content-Range`) plus
 * the conditional-request handling that Range correctness depends on (`ETag` /
 * `Last-Modified` / `If-Range` / `If-None-Match` / `If-Modified-Since` → `304`).
 *
 * `parseByteRange` and the validator helpers are pure and runtime-neutral — they
 * never touch `Bun` and are unit-testable on their own. `serveFile` is the
 * Bun-first responder built on top, using `Bun.file().slice()` so a range body
 * streams without reading the whole file into memory (unlike `staticRoute`). A
 * Node variant (`node:fs.createReadStream`) is a separate follow-up. → ADR 0023.
 */
import { mimeForPath } from './mime';

/** An inclusive byte range `[start, end]`. */
export interface ByteRange {
  start: number;
  end: number;
}

/**
 * Parse a single-range `Range` header against a known `size`.
 *
 * - `null` — no header, malformed, or multiple ranges (caller serves the full
 *   `200` body; ignoring an unparseable Range is RFC-compliant).
 * - `'unsatisfiable'` — a well-formed range that lies outside the file (the
 *   caller answers `416` with `Content-Range: bytes * /size`).
 * - `{ start, end }` — an inclusive, clamped range to serve as `206`.
 *
 * Multiple ranges (`bytes=0-9,20-29`) are intentionally unsupported and return
 * `null` (no `multipart/byteranges`). → ADR 0023.
 */
export function parseByteRange(
  header: string | null,
  size: number,
): ByteRange | 'unsatisfiable' | null {
  if (!header) return null;
  const match = /^bytes=(.+)$/.exec(header.trim());
  const rawSpec = match?.[1];
  if (rawSpec === undefined) return null;
  const spec = rawSpec.trim();
  // Multiple ranges — not supported; ignore Range and serve the full body.
  if (spec.includes(',')) return null;

  const dash = spec.indexOf('-');
  if (dash === -1) return null;
  const startStr = spec.slice(0, dash).trim();
  const endStr = spec.slice(dash + 1).trim();

  // Suffix range: `bytes=-N` → the last N bytes.
  if (startStr === '') {
    if (!/^\d+$/.test(endStr)) return null;
    const suffix = Number(endStr);
    // `bytes=-0` (last zero bytes) and any suffix on an empty file: nothing to send.
    if (suffix === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }

  if (!/^\d+$/.test(startStr)) return null;
  const start = Number(startStr);
  if (size === 0 || start >= size) return 'unsatisfiable';

  // Open-ended: `bytes=N-` → N to the last byte.
  if (endStr === '') return { start, end: size - 1 };
  if (!/^\d+$/.test(endStr)) return null;

  const end = Number(endStr);
  if (end < start) return null; // malformed, e.g. `bytes=5-3`
  return { start, end: end >= size ? size - 1 : end };
}

/**
 * A weak entity tag derived from size + mtime — cheap (no content hashing) and
 * stable across requests. Weak because two files with the same size and mtime
 * are treated as equivalent, which is the right trade for static media.
 */
export function weakETag(size: number, mtimeMs: number): string {
  return `W/"${size.toString(16)}-${Math.floor(mtimeMs).toString(16)}"`;
}

// Only the validators that are actually emitted participate — a disabled `etag`
// or `lastModified` is `undefined` and never matched (a client cannot revalidate
// against a validator the response does not advertise).
interface Validators {
  etag?: string;
  lastModifiedMs?: number;
}

/** HTTP dates have one-second resolution — compare on whole seconds. */
function leSeconds(aMs: number, bMs: number): boolean {
  return Math.floor(aMs / 1000) <= Math.floor(bMs / 1000);
}

/**
 * `304 Not Modified` decision. `If-None-Match` wins over `If-Modified-Since`
 * (RFC 9110 §13.1.3); a bare `*` matches any existing representation (so it holds
 * even with no validator emitted — the resource exists). A specific tag / date is
 * matched only against an enabled validator.
 */
function isNotModified(req: Request, v: Validators): boolean {
  const inm = req.headers.get('if-none-match');
  if (inm !== null) {
    const value = inm.trim();
    if (value === '*') return true;
    if (v.etag === undefined) return false;
    return value
      .split(',')
      .map((t) => t.trim())
      .includes(v.etag);
  }
  const ims = req.headers.get('if-modified-since');
  if (ims !== null) {
    if (v.lastModifiedMs === undefined) return false;
    const since = Date.parse(ims);
    if (Number.isNaN(since)) return false;
    return leSeconds(v.lastModifiedMs, since);
  }
  return false;
}

/**
 * `If-Range` gate: honour the `Range` only when the client's validator still
 * matches the current file, otherwise serve the full `200` (so a changed file is
 * never stitched together from stale and fresh bytes). No `If-Range` → honour.
 * Compared only against enabled validators.
 */
function ifRangeMatches(req: Request, v: Validators): boolean {
  const ir = req.headers.get('if-range');
  if (ir === null) return true;
  const value = ir.trim();
  if (v.etag !== undefined && value === v.etag) return true;
  if (v.lastModifiedMs !== undefined) {
    const asDate = Date.parse(value);
    if (!Number.isNaN(asDate)) return leSeconds(v.lastModifiedMs, asDate);
  }
  return false;
}

/** ASCII fallback for a `Content-Disposition` filename — no regex, no raw bytes. */
function asciiFilename(filename: string): string {
  let out = '';
  for (let i = 0; i < filename.length; i++) {
    const code = filename.charCodeAt(i);
    // Printable ASCII, minus the quote and backslash that break the quoted form.
    out +=
      code >= 0x20 && code < 0x7f && code !== 0x22 && code !== 0x5c ? filename.charAt(i) : '_';
  }
  return out;
}

function contentDisposition(disposition: 'inline' | 'attachment', filename: string): string {
  // ASCII `filename=` for old clients + RFC 5987 `filename*=` for the real name.
  return `${disposition}; filename="${asciiFilename(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export interface ServeFileOptions {
  /** Absolute (or cwd-relative) path to the file. The caller owns containment. */
  path: string;
  /** MIME type. Auto-detected from the path extension when omitted. */
  contentType?: string;
  /** Sets `Content-Disposition` with this filename. */
  filename?: string;
  /** `Content-Disposition` type. Defaults to `inline` (set with `filename`). */
  disposition?: 'inline' | 'attachment';
  /** Value for the `Cache-Control` header, verbatim. */
  cacheControl?: string;
  /** Emit a weak `ETag` (default `true`). */
  etag?: boolean;
  /** Emit `Last-Modified` (default `true`). */
  lastModified?: boolean;
}

/**
 * Serve a file with full Range + conditional-request support. Returns:
 * `405` (non GET/HEAD), `404` (missing), `304` (fresh per `If-None-Match` /
 * `If-Modified-Since`), `200` (full — no/ignored Range), `206` (range), or `416`
 * (unsatisfiable range). Always sets `Accept-Ranges: bytes` and `nosniff`; a
 * `HEAD` returns every header with an empty body.
 *
 * Bun-first (`Bun.file`). The caller is responsible for path containment — for
 * URL-derived paths use `staticRoute` or `isWithinDir`. → ADR 0023.
 */
export async function serveFile(req: Request, opts: ServeFileOptions): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return new Response('Method not allowed', {
      status: 405,
      headers: { Allow: 'GET, HEAD' },
    });
  }

  const file = Bun.file(opts.path);
  if (!(await file.exists())) {
    return new Response('Not found', { status: 404 });
  }

  const size = file.size;
  const mtimeMs = file.lastModified;
  const contentType = opts.contentType ?? mimeForPath(opts.path);
  const useEtag = opts.etag !== false;
  const useLastModified = opts.lastModified !== false;
  // Build only the validators we advertise — a disabled one stays `undefined` so
  // conditional checks never match against a validator the response omits.
  const etag = useEtag ? weakETag(size, mtimeMs) : undefined;
  const validators: Validators = {
    etag,
    lastModifiedMs: useLastModified ? mtimeMs : undefined,
  };
  const isHead = req.method === 'HEAD';

  const base = new Headers();
  base.set('Accept-Ranges', 'bytes');
  base.set('X-Content-Type-Options', 'nosniff');
  if (etag) base.set('ETag', etag);
  if (useLastModified) base.set('Last-Modified', new Date(mtimeMs).toUTCString());
  if (opts.cacheControl) base.set('Cache-Control', opts.cacheControl);
  if (opts.filename) {
    base.set(
      'Content-Disposition',
      contentDisposition(opts.disposition ?? 'inline', opts.filename),
    );
  } else if (opts.disposition) {
    base.set('Content-Disposition', opts.disposition);
  }

  // 304 — only when we actually expose a validator to compare against.
  if ((useEtag || useLastModified) && isNotModified(req, validators)) {
    return new Response(null, { status: 304, headers: base });
  }

  const rangeHeader = req.headers.get('range');
  const range =
    rangeHeader !== null && ifRangeMatches(req, validators)
      ? parseByteRange(rangeHeader, size)
      : null;

  if (range === 'unsatisfiable') {
    base.set('Content-Range', `bytes */${size}`);
    base.set('Content-Type', contentType);
    return new Response(null, { status: 416, headers: base });
  }

  if (range) {
    const length = range.end - range.start + 1;
    base.set('Content-Type', contentType);
    base.set('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
    base.set('Content-Length', String(length));
    // `slice(start, end + 1)` — Bun's slice is end-exclusive; streams the range.
    const body = isHead ? null : file.slice(range.start, range.end + 1);
    return new Response(body, { status: 206, headers: base });
  }

  base.set('Content-Type', contentType);
  base.set('Content-Length', String(size));
  return new Response(isHead ? null : file, { status: 200, headers: base });
}
