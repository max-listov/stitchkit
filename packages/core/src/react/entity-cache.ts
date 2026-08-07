/**
 * Declarative CRUD cache handlers for `createCacheBridge`. One config projects
 * a full event entity into the cached list item and patches plain, paginated or
 * infinite TanStack Query data without changing its envelope metadata.
 */
import type { InfiniteData, QueryKey } from '@tanstack/react-query';
import type { Paginated } from '../contract';
import { isRecord } from '../internal/typed';
import type { CacheBridgeContext, CacheBridgeHandler } from './cache-bridge';

/** The `deleted` event may carry the whole entity or only its id. */
export type DeletedPayload<TData> = TData | { id: string };

/** Typed event passed to dynamic list/detail query-key selectors. */
export type EntityCacheEvent<TData> =
  | { type: 'created'; entity: TData; id: string }
  | { type: 'updated'; entity: TData; id: string }
  | { type: 'deleted'; payload: DeletedPayload<TData>; id: string };

/** A static cache key/prefix or an event-aware key factory. */
export type EntityCacheKey<TData> = QueryKey | ((event: EntityCacheEvent<TData>) => QueryKey);

export type EntityCacheListShape =
  | 'array'
  | 'paginated'
  | 'infinite-array'
  | 'infinite-paginated';

/** List envelope, scoped key and explicit CRUD policies. */
export interface EntityCacheListConfig<TData, TListItem> {
  /** Static query-key prefix or an event-aware scoped key factory. */
  key: EntityCacheKey<TData>;
  /** Edge/page used for a create or an inserted missing update. */
  createAt: 'start' | 'end';
  /** Explicit behavior when an update's id is absent from every cached page. */
  updateMissing: 'skip' | 'insert';
  /** Backend-equivalent ordering for each affected logical item array. */
  compare?: (left: TListItem, right: TListItem) => number;
  /** Cached data envelope; no runtime shape inference is performed. */
  shape: EntityCacheListShape;
}

/** Config for `createEntityCacheHandlers`. */
export interface EntityCacheConfig<TData, TListItem = TData> {
  /** Canonical id from a full created/updated entity. */
  getId: (entity: TData) => string;
  /** Canonical id from the projected item stored in list caches. */
  getListItemId: (item: TListItem) => string;
  /** Project a full mutation entity into the list cache's item type. */
  toListItem: (entity: TData) => TListItem;
  /** Read a deleted id. Default: a string `.id`, otherwise `getId(payload)`. */
  getDeletedId?: (payload: DeletedPayload<TData>) => string;
  /** List envelope, key/prefix, insertion policy and optional ordering. */
  list: EntityCacheListConfig<TData, TListItem>;
  /** Static detail key or event-aware key factory. Omit to skip detail updates. */
  detailKey?: EntityCacheKey<TData>;
}

/** The three handlers to wire onto a `createCacheBridge` handlers map. */
export interface EntityCacheHandlers<TData> {
  created: CacheBridgeHandler<TData>;
  updated: CacheBridgeHandler<TData>;
  deleted: CacheBridgeHandler<DeletedPayload<TData>>;
}

type ListMutation<TListItem> =
  | { type: 'created'; id: string; item: TListItem }
  | { type: 'updated'; id: string; item: TListItem }
  | { type: 'deleted'; id: string };

interface EntityCacheMutationPolicy<TListItem> {
  createAt: 'start' | 'end';
  updateMissing: 'skip' | 'insert';
  compare?: (left: TListItem, right: TListItem) => number;
}

function resolveKey<TData>(
  key: EntityCacheKey<TData>,
  event: EntityCacheEvent<TData>,
): QueryKey {
  return typeof key === 'function' ? key(event) : key;
}

function ordered<TListItem>(
  items: TListItem[],
  compare: ((left: TListItem, right: TListItem) => number) | undefined,
): TListItem[] {
  return compare ? [...items].sort(compare) : items;
}

function insertAt<TListItem>(
  items: TListItem[],
  item: TListItem,
  at: 'start' | 'end',
  compare: ((left: TListItem, right: TListItem) => number) | undefined,
): TListItem[] {
  return ordered(at === 'start' ? [item, ...items] : [...items, item], compare);
}

/** Mutate one or more logical item arrays while keeping their outer envelopes intact. */
function mutateItemArrays<TListItem>(
  arrays: TListItem[][],
  mutation: ListMutation<TListItem>,
  config: EntityCacheMutationPolicy<TListItem>,
  getId: (item: TListItem) => string,
): TListItem[][] {
  const present = arrays.some((items) => items.some((item) => getId(item) === mutation.id));
  if (mutation.type === 'created' && present) return arrays;
  if (mutation.type === 'updated' && !present && config.updateMissing === 'skip') {
    return arrays;
  }

  if (mutation.type !== 'deleted' && (!present || mutation.type === 'created')) {
    if (arrays.length === 0) return arrays;
    const target = config.createAt === 'start' ? 0 : arrays.length - 1;
    return arrays.map((items, index) =>
      index === target
        ? insertAt(items, mutation.item, config.createAt, config.compare)
        : items,
    );
  }

  if (mutation.type === 'deleted') {
    return arrays.map((items) => items.filter((item) => getId(item) !== mutation.id));
  }

  return arrays.map((items) =>
    ordered(
      items.map((item) => (getId(item) === mutation.id ? mutation.item : item)),
      config.compare,
    ),
  );
}

function firstArray<TListItem>(arrays: TListItem[][]): TListItem[] {
  const first = arrays[0];
  if (!first) throw new Error('Entity cache list adapter lost its only item array');
  return first;
}

function unsupportedListShape(shape: never): never {
  throw new Error(`Unsupported entity cache list shape: ${String(shape)}`);
}

function patchList<TData, TListItem>(
  context: CacheBridgeContext,
  key: QueryKey,
  config: EntityCacheListConfig<TData, TListItem>,
  mutation: ListMutation<TListItem>,
  getId: (item: TListItem) => string,
): void {
  const mutate = (arrays: TListItem[][]): TListItem[][] =>
    mutateItemArrays(arrays, mutation, config, getId);

  switch (config.shape) {
    case 'array':
      context.queryClient.setQueriesData<TListItem[]>({ queryKey: key }, (old) =>
        Array.isArray(old) ? firstArray(mutate([old])) : old,
      );
      return;
    case 'paginated':
      context.queryClient.setQueriesData<Paginated<TListItem>>({ queryKey: key }, (old) =>
        isRecord(old) && Array.isArray(old.items)
          ? { ...old, items: firstArray(mutate([old.items])) }
          : old,
      );
      return;
    case 'infinite-array':
      context.queryClient.setQueriesData<InfiniteData<TListItem[]>>(
        { queryKey: key },
        (old) =>
          isRecord(old) &&
          Array.isArray(old.pages) &&
          old.pages.every((page) => Array.isArray(page))
            ? { ...old, pages: mutate(old.pages) }
            : old,
      );
      return;
    case 'infinite-paginated':
      context.queryClient.setQueriesData<InfiniteData<Paginated<TListItem>>>(
        { queryKey: key },
        (old) => {
          if (
            !isRecord(old) ||
            !Array.isArray(old.pages) ||
            !old.pages.every((page) => isRecord(page) && Array.isArray(page.items))
          ) {
            return old;
          }
          const items = mutate(old.pages.map((page) => page.items));
          return {
            ...old,
            pages: old.pages.map((page, index) => {
              const pageItems = items[index];
              if (!pageItems) {
                throw new Error('Entity cache list adapter changed the page count');
              }
              return { ...page, items: pageItems };
            }),
          };
        },
      );
      return;
    default:
      unsupportedListShape(config.shape);
  }
}

/**
 * Build created/updated/deleted cache handlers over one declared list shape.
 * Every event resolves its own scoped keys and applies the same fresh-echo gate.
 */
export function createEntityCacheHandlers<TData, TListItem = TData>(
  config: EntityCacheConfig<TData, TListItem>,
): EntityCacheHandlers<TData> {
  const deletedId =
    config.getDeletedId ?? ((payload: DeletedPayload<TData>) => idOf(payload, config.getId));

  const apply = (
    event: EntityCacheEvent<TData>,
    mutation: ListMutation<TListItem>,
    context: CacheBridgeContext,
  ): boolean => {
    const listKey = resolveKey(config.list.key, event);
    const detailKey = config.detailKey ? resolveKey(config.detailKey, event) : undefined;
    if (context.isFresh(detailKey ?? listKey)) return false;
    patchList(context, listKey, config.list, mutation, config.getListItemId);
    return true;
  };

  return {
    created(entity, context) {
      const id = config.getId(entity);
      const event: EntityCacheEvent<TData> = { type: 'created', entity, id };
      if (!apply(event, { type: 'created', id, item: config.toListItem(entity) }, context)) {
        return;
      }
      if (config.detailKey) {
        context.queryClient.setQueryData(resolveKey(config.detailKey, event), entity);
      }
    },

    updated(entity, context) {
      const id = config.getId(entity);
      const event: EntityCacheEvent<TData> = { type: 'updated', entity, id };
      if (!apply(event, { type: 'updated', id, item: config.toListItem(entity) }, context)) {
        return;
      }
      if (config.detailKey) {
        context.queryClient.setQueryData(resolveKey(config.detailKey, event), entity);
      }
    },

    deleted(payload, context) {
      const id = deletedId(payload);
      const event: EntityCacheEvent<TData> = { type: 'deleted', payload, id };
      if (!apply(event, { type: 'deleted', id }, context)) return;
      if (config.detailKey) {
        context.queryClient.removeQueries({
          queryKey: resolveKey(config.detailKey, event),
        });
      }
    },
  };
}

function hasStringId(value: unknown): value is { id: string } {
  return isRecord(value) && typeof value.id === 'string';
}

function idOf<TData>(
  payload: DeletedPayload<TData>,
  getId: (entity: TData) => string,
): string {
  return hasStringId(payload) ? payload.id : getId(payload);
}
