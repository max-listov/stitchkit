/**
 * Declarative CRUD cache handlers for `createCacheBridge` — the created /
 * updated / deleted socket events of one entity, patched into its list and
 * detail queries. Every project hand-rolls this same updater; this builds it
 * from a small config.
 *
 * It patches stitchkit's own `Paginated<T>` list envelope (plain or a TanStack
 * `InfiniteData` of it) and the entity's detail query. It does **not** flatten
 * pages or expose a `useAllX` surface — flattening stays in the component (a
 * deliberate boundary): this only keeps the cache correct.
 *
 * ```ts
 * const handlers = createEntityCacheHandlers<Widget>({
 *   getId: (w) => w.id,
 *   listKey: ['widgets'],
 *   detailKey: (id) => ['widgets', id],
 * });
 * createCacheBridge({ socket, queryClient, handlers: {
 *   widgetCreated: handlers.created,
 *   widgetUpdated: handlers.updated,
 *   widgetDeleted: handlers.deleted,
 * }});
 * ```
 */
import type { InfiniteData, QueryKey } from '@tanstack/react-query';
import type { Paginated } from '../contract';
import { isRecord } from '../internal/typed';
import type { CacheBridgeContext, CacheBridgeHandler } from './cache-bridge';

/** A list query's cached shape — a plain page or an infinite list of pages. */
type ListData<T> = Paginated<T> | InfiniteData<Paginated<T>>;

/** The `deleted` event may carry the whole entity or just its id. */
export type DeletedPayload<T> = T | { id: string };

/** Config for `createEntityCacheHandlers`. */
export interface EntityCacheConfig<T> {
  /** Read the entity's id — the identity used to match, replace and remove. */
  getId: (entity: T) => string;
  /** Read the id from a `deleted` payload (entity or `{ id }`). Default `getId` / `.id`. */
  getDeletedId?: (payload: DeletedPayload<T>) => string;
  /** Query key (or prefix) of the list(s) to patch — matched by partial equality. */
  listKey: QueryKey;
  /** Build the detail query key for an id. Omit to skip detail-cache updates. */
  detailKey?: (id: string) => QueryKey;
}

/** The three handlers to wire onto a `createCacheBridge` `handlers` map. */
export interface EntityCacheHandlers<T> {
  created: CacheBridgeHandler<T>;
  updated: CacheBridgeHandler<T>;
  deleted: CacheBridgeHandler<DeletedPayload<T>>;
}

/** Apply `fn` to every page's `items`, preserving the plain-vs-infinite shape. */
function patchItems<T>(
  data: ListData<T> | undefined,
  fn: (items: T[]) => T[],
): ListData<T> | undefined {
  if (!data) return data;
  if ('pages' in data) {
    return { ...data, pages: data.pages.map((page) => ({ ...page, items: fn(page.items) })) };
  }
  return { ...data, items: fn(data.items) };
}

/** Prepend to the first page only (plain list, or `pages[0]` of an infinite one). */
function prepend<T>(data: ListData<T> | undefined, entity: T): ListData<T> | undefined {
  if (!data) return data;
  if ('pages' in data) {
    const [first, ...rest] = data.pages;
    if (!first) return data;
    return { ...data, pages: [{ ...first, items: [entity, ...first.items] }, ...rest] };
  }
  return { ...data, items: [entity, ...data.items] };
}

/**
 * Build created / updated / deleted cache handlers for one entity. Each skips a
 * stale socket echo of a change the client just made (`ctx.isFresh`), keyed on
 * the entity's detail key when available, else the list key.
 */
export function createEntityCacheHandlers<T>(
  config: EntityCacheConfig<T>,
): EntityCacheHandlers<T> {
  const { getId, listKey, detailKey } = config;
  const deletedId =
    config.getDeletedId ?? ((payload: DeletedPayload<T>) => idOf(payload, getId));

  const freshKey = (id: string): QueryKey => (detailKey ? detailKey(id) : listKey);

  const patchList = (ctx: CacheBridgeContext, fn: (items: T[]) => T[]): void => {
    ctx.queryClient.setQueriesData<ListData<T>>({ queryKey: listKey }, (old) =>
      patchItems(old, fn),
    );
  };

  return {
    created(entity, ctx) {
      const id = getId(entity);
      if (ctx.isFresh(freshKey(id))) return;
      ctx.queryClient.setQueriesData<ListData<T>>({ queryKey: listKey }, (old) => {
        // Skip if an item with this id is already cached (avoid a duplicate).
        const present = hasId(old, getId, id);
        return present ? old : prepend(old, entity);
      });
      if (detailKey) ctx.queryClient.setQueryData(detailKey(id), entity);
    },

    updated(entity, ctx) {
      const id = getId(entity);
      if (ctx.isFresh(freshKey(id))) return;
      patchList(ctx, (items) => items.map((item) => (getId(item) === id ? entity : item)));
      if (detailKey) ctx.queryClient.setQueryData(detailKey(id), entity);
    },

    deleted(payload, ctx) {
      const id = deletedId(payload);
      if (ctx.isFresh(freshKey(id))) return;
      patchList(ctx, (items) => items.filter((item) => getId(item) !== id));
      if (detailKey) ctx.queryClient.removeQueries({ queryKey: detailKey(id) });
    },
  };
}

/** A payload carrying a string `id` — a type predicate, no cast. */
function hasStringId(value: unknown): value is { id: string } {
  return isRecord(value) && typeof value.id === 'string';
}

/** Read the id from a `deleted` payload — a bare `{ id }`, else the entity via `getId`. */
function idOf<T>(payload: DeletedPayload<T>, getId: (entity: T) => string): string {
  return hasStringId(payload) ? payload.id : getId(payload);
}

/** Whether any cached page already holds an item with `id`. */
function hasId<T>(
  data: ListData<T> | undefined,
  getId: (entity: T) => string,
  id: string,
): boolean {
  if (!data) return false;
  const pages = 'pages' in data ? data.pages : [data];
  return pages.some((page) => page.items.some((item) => getId(item) === id));
}
