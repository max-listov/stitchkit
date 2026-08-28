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

export type EntityCacheMembership = 'include' | 'exclude' | 'unknown';

export interface EntityCacheMembershipPolicy<TData> {
  /** Backend-equivalent membership for this exact cached query key. */
  evaluate(event: EntityCacheEvent<TData>, queryKey: QueryKey): EntityCacheMembership;
  /** What to do when the event cannot prove membership. Default `preserve`. */
  unknown?: 'preserve' | 'invalidate';
}

export interface EntityCacheTotalDeltaInput<TData> {
  event: EntityCacheEvent<TData>;
  queryKey: QueryKey;
  present: boolean;
  membership: EntityCacheMembership;
}

export interface EntityCacheTotalPolicy<TData> {
  /** Reconcile a numeric `total` field when the event proves a delta. */
  mode: 'reconcile';
  /** Override the conservative built-in delta when the event carries transition evidence. */
  delta?(input: EntityCacheTotalDeltaInput<TData>): number | 'unknown';
  /** What to do when an unseen id makes the delta unknowable. Default `preserve`. */
  unknown?: 'preserve' | 'invalidate';
}

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
  /** Optional per-query filter membership. Omit for the envelope-preserving legacy path. */
  membership?: EntityCacheMembershipPolicy<TData>;
  /** Optional reconciliation of a numeric paginated `total` field. */
  total?: EntityCacheTotalPolicy<TData>;
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

interface ItemArrayMutation<TListItem> {
  arrays: TListItem[][];
  present: boolean;
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
): ItemArrayMutation<TListItem> {
  const present = arrays.some((items) => items.some((item) => getId(item) === mutation.id));
  if (mutation.type === 'created' && present) return { arrays, present };
  if (mutation.type === 'updated' && !present && config.updateMissing === 'skip') {
    return { arrays, present };
  }

  if (mutation.type !== 'deleted' && (!present || mutation.type === 'created')) {
    if (arrays.length === 0) return { arrays, present };
    const target = config.createAt === 'start' ? 0 : arrays.length - 1;
    return {
      arrays: arrays.map((items, index) =>
        index === target
          ? insertAt(items, mutation.item, config.createAt, config.compare)
          : items,
      ),
      present,
    };
  }

  if (mutation.type === 'deleted') {
    return {
      arrays: arrays.map((items) => items.filter((item) => getId(item) !== mutation.id)),
      present,
    };
  }

  return {
    arrays: arrays.map((items) =>
      ordered(
        items.map((item) => (getId(item) === mutation.id ? mutation.item : item)),
        config.compare,
      ),
    ),
    present,
  };
}

function firstArray<TListItem>(arrays: TListItem[][]): TListItem[] {
  const first = arrays[0];
  if (!first) throw new Error('Entity cache list adapter lost its only item array');
  return first;
}

type TotalDelta = number | 'unknown';

function totalDelta<TListItem>(
  mutation: ListMutation<TListItem>,
  present: boolean,
  membership: EntityCacheMembership,
): TotalDelta {
  if (mutation.type === 'deleted') {
    if (present) return -1;
    // An unseen delete may be a duplicate or an entity on an unloaded page.
    return 'unknown';
  }
  if (membership === 'unknown') return 'unknown';
  if (mutation.type === 'created') {
    if (present) return 0;
    return membership === 'include' ? 1 : 0;
  }
  if (present) return membership === 'exclude' ? -1 : 0;
  // An unseen update does not prove whether the entity crossed the filter or
  // was already on an unloaded page.
  return 'unknown';
}

function reconcileTotal<T extends object>(value: T, delta: TotalDelta): T {
  if (delta === 'unknown') return value;
  if (!Number.isSafeInteger(delta)) {
    throw new Error('Entity cache total delta must be a safe integer or "unknown"');
  }
  const current = Reflect.get(value, 'total');
  if (typeof current !== 'number' || !Number.isSafeInteger(current) || current < 0) {
    return value;
  }
  return { ...value, total: Math.max(0, current + delta) };
}

function unsupportedListShape(shape: never): never {
  throw new Error(`Unsupported entity cache list shape: ${String(shape)}`);
}

function patchList<TData, TListItem>(
  context: CacheBridgeContext,
  key: QueryKey,
  config: EntityCacheListConfig<TData, TListItem>,
  event: EntityCacheEvent<TData>,
  mutation: ListMutation<TListItem>,
  getId: (item: TListItem) => string,
): void {
  const queries = context.queryClient.getQueryCache().findAll({ queryKey: key });
  const patchExact = (exactKey: QueryKey, membership: EntityCacheMembership): void => {
    const effectiveMutation: ListMutation<TListItem> =
      membership === 'exclude' && mutation.type !== 'deleted'
        ? { type: 'deleted', id: mutation.id }
        : mutation;
    const unknown = membership === 'unknown';
    if (unknown && mutation.type !== 'deleted') {
      if (
        config.membership?.unknown === 'invalidate' ||
        config.total?.unknown === 'invalidate'
      ) {
        void context.queryClient.invalidateQueries({ queryKey: exactKey, exact: true });
      }
      return;
    }
    let invalidateMembership = false;
    const mutate = (arrays: TListItem[][]): ItemArrayMutation<TListItem> => {
      const result = mutateItemArrays(arrays, effectiveMutation, config, getId);
      if (
        membership === 'unknown' &&
        mutation.type === 'deleted' &&
        !result.present &&
        config.membership?.unknown === 'invalidate'
      ) {
        invalidateMembership = true;
      }
      return result;
    };
    let invalidateTotal = false;
    const reconcile = <T extends object>(value: T, delta: TotalDelta): T => {
      if (delta === 'unknown' && config.total?.unknown === 'invalidate') {
        invalidateTotal = true;
      }
      return reconcileTotal(value, delta);
    };
    const invalidateIfNeeded = (): void => {
      if (invalidateMembership || invalidateTotal) {
        void context.queryClient.invalidateQueries({ queryKey: exactKey, exact: true });
      }
    };

    switch (config.shape) {
      case 'array':
        context.queryClient.setQueryData<TListItem[]>(exactKey, (old) =>
          Array.isArray(old) ? firstArray(mutate([old]).arrays) : old,
        );
        invalidateIfNeeded();
        return;
      case 'paginated':
        context.queryClient.setQueryData<Paginated<TListItem>>(exactKey, (old) => {
          if (!isRecord(old) || !Array.isArray(old.items)) return old;
          const result = mutate([old.items]);
          const patched = { ...old, items: firstArray(result.arrays) };
          const delta =
            config.total?.delta?.({
              event,
              queryKey: exactKey,
              present: result.present,
              membership,
            }) ?? totalDelta(mutation, result.present, membership);
          return config.total ? reconcile(patched, delta) : patched;
        });
        invalidateIfNeeded();
        return;
      case 'infinite-array':
        context.queryClient.setQueryData<InfiniteData<TListItem[]>>(exactKey, (old) =>
          isRecord(old) &&
          Array.isArray(old.pages) &&
          old.pages.every((page) => Array.isArray(page))
            ? { ...old, pages: mutate(old.pages).arrays }
            : old,
        );
        invalidateIfNeeded();
        return;
      case 'infinite-paginated':
        context.queryClient.setQueryData<InfiniteData<Paginated<TListItem>>>(
          exactKey,
          (old) => {
            if (
              !isRecord(old) ||
              !Array.isArray(old.pages) ||
              !old.pages.every((page) => isRecord(page) && Array.isArray(page.items))
            ) {
              return old;
            }
            const result = mutate(old.pages.map((page) => page.items));
            const delta =
              config.total?.delta?.({
                event,
                queryKey: exactKey,
                present: result.present,
                membership,
              }) ?? totalDelta(mutation, result.present, membership);
            return {
              ...old,
              pages: old.pages.map((page, index) => {
                const pageItems = result.arrays[index];
                if (!pageItems) {
                  throw new Error('Entity cache list adapter changed the page count');
                }
                const patched = { ...page, items: pageItems };
                return config.total ? reconcile(patched, delta) : patched;
              }),
            };
          },
        );
        invalidateIfNeeded();
        return;
      default:
        unsupportedListShape(config.shape);
    }
  };

  for (const query of queries) {
    const exactKey = query.queryKey;
    // Without a predicate the list is unfiltered, which is the exact legacy
    // behavior.
    patchExact(exactKey, config.membership?.evaluate(event, exactKey) ?? 'include');
  }
}

/**
 * Build created/updated/deleted cache handlers over one declared list shape.
 * Every event resolves its own scoped keys and applies the same fresh-echo gate.
 */
export function createEntityCacheHandlers<TData, TListItem = TData>(
  config: EntityCacheConfig<TData, TListItem>,
): EntityCacheHandlers<TData> {
  if (
    config.list.total &&
    config.list.shape !== 'paginated' &&
    config.list.shape !== 'infinite-paginated'
  ) {
    throw new Error('Entity cache total policy requires a paginated list shape');
  }
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
    patchList(context, listKey, config.list, event, mutation, config.getListItemId);
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
