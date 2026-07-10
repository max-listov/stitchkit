import { type ZodType, z } from 'zod';
import { base64UrlToBytes, bytesToBase64Url } from '../internal/base64url';

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
// UTF-8-safe base64url: a non-ASCII sort value (a name, an emoji) round-trips,
// which a naïve `btoa(JSON)` corrupts. The byte codec is shared (see
// `internal/base64url`); this wraps it around a UTF-8 string.

function toBase64Url(str: string): string {
  return bytesToBase64Url(new TextEncoder().encode(str));
}

function fromBase64Url(value: string): string {
  return new TextDecoder().decode(base64UrlToBytes(value));
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
