/**
 * Cursor-paginated infinite query — the family's canonical pagination hook.
 *
 * Built on `react-query-kit`'s `createInfiniteQuery` (the family's hook layer),
 * so the result keeps the full rqk surface: `.getKey()`, `.fetcher`,
 * `useSuspenseInfiniteQuery`, every option. Cursor pagination is immune to
 * concurrent inserts — offset paging drops or duplicates rows when a new row
 * lands on top of the list.
 *
 * Pass the typed contract method as `endpoint` (e.g. `apiClient.media.list`).
 * The helper injects `cursor` from the page param and bakes in
 * `getNextPageParam` / `initialPageParam`. An infinite hook is therefore just
 * `queryKey + endpoint` — no per-hook fetcher, no pagination plumbing. Every
 * other rqk option (`staleTime`, `gcTime`, `refetch*`, …) passes through.
 *
 * Page size is NOT a client concern: the helper never sends `limit`, so the
 * server applies the contract's `limit` default (`z.coerce.number().default(N)`).
 * That default is the single source of truth — the client cannot diverge.
 */
import {
  type CompatibleError,
  type CreateInfiniteQueryOptions,
  createInfiniteQuery,
} from 'react-query-kit';

/** The cursor field the helper owns — the caller never passes it. */
interface CursorParam {
  cursor?: string;
}

/** Options the helper computes itself; the caller cannot override them. */
type ControlledKeys = 'fetcher' | 'initialPageParam' | 'getNextPageParam';

export type CursorQueryConfig<
  TVars,
  TPage extends { nextCursor: string | null },
  TError,
> = Omit<CreateInfiniteQueryOptions<TPage, TVars, TError, string | null>, ControlledKeys> & {
  /** Contract method, e.g. `apiClient.media.list`. */
  endpoint: (args: TVars & CursorParam) => Promise<TPage>;
};

export function createCursorQuery<
  TVars,
  TPage extends { nextCursor: string | null },
  TError = CompatibleError,
>(config: CursorQueryConfig<TVars, TPage, TError>) {
  const { endpoint, ...rest } = config;

  return createInfiniteQuery<TPage, TVars, TError, string | null>({
    ...rest,
    // `cursor` is typed exactly as `CursorParam`, so the merged object
    // satisfies `endpoint`'s `TVars & CursorParam` — no cast.
    fetcher: (variables, { pageParam }) =>
      endpoint({ ...variables, cursor: pageParam ?? undefined }),
    initialPageParam: null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });
}
