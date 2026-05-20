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
