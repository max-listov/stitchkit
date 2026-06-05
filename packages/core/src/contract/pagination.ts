import { type ZodType, z } from 'zod';

/**
 * Cursor-paginated response envelope — the family standard.
 *
 * Every list endpoint returns this shape: an `items` array plus an opaque
 * `nextCursor` (`null` at the end). One envelope → one infinite-query helper
 * (`createCursorQuery`) with zero per-endpoint accessors. Domain extras (a
 * `total` counter, `stats`) are added alongside via `.extend()`.
 */
export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
}

/** Zod schema for a `Paginated<T>` response of `itemSchema`. */
export function paginatedSchema<T extends ZodType>(itemSchema: T) {
  return z.object({
    items: z.array(itemSchema),
    nextCursor: z.string().nullable(),
  });
}

// ─── Opaque cursor codec ─────────────────────────────────────────────────────
//
// stitchkit owns the `{ items, nextCursor }` envelope and the `createCursorQuery`
// client, but the *format* of `nextCursor` is the server's choice. Most servers
// want a keyset cursor — the last row's `(sortValue, id)` — encoded opaquely. The
// encode/decode is identical everywhere and gets re-implemented per project, so
// it lives here. The keyset WHERE clause stays in the app (it is ORM-specific) —
// this is only the string ⇄ value codec.
//
// base64url over UTF-8 via `btoa`/`atob` (not Node `Buffer`) — works in the
// server, the typed client and the browser; UTF-8-safe, so a non-ASCII sort
// value (a name, an emoji) round-trips, which a naïve `btoa(JSON)` corrupts.

function toBase64Url(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): string {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  return new TextDecoder().decode(Uint8Array.from(atob(padded), (c) => c.charCodeAt(0)));
}

/**
 * Encode a JSON-serializable value (e.g. a keyset `{ v, id }`) into an opaque,
 * URL-safe cursor string for `nextCursor`.
 */
export function encodeCursor(value: unknown): string {
  return toBase64Url(JSON.stringify(value));
}

/**
 * Decode a cursor produced by {@link encodeCursor} and validate it against
 * `schema`. Returns `null` for a missing, malformed or schema-invalid cursor —
 * so a garbage cursor in a URL is treated as "no cursor" rather than throwing.
 */
export function decodeCursor<T>(
  cursor: string | null | undefined,
  schema: ZodType<T>,
): T | null {
  if (!cursor) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(fromBase64Url(cursor)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
