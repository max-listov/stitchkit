import { describe, expect, test } from 'bun:test';
import { type InfiniteData, QueryClient } from '@tanstack/react-query';
import type { Paginated } from '../src/contract';
import {
  type CacheBridgeContext,
  createEntityCacheHandlers,
  type EntityCacheEvent,
  type EntityCacheListShape,
} from '../src/react';

interface Widget {
  id: string;
  workspaceId: string;
  name: string;
  rank: number;
  secret: string;
}

interface WidgetListItem {
  id: string;
  label: string;
  rank: number;
}

const one: Widget = {
  id: '1',
  workspaceId: 'a',
  name: 'one',
  rank: 1,
  secret: 's1',
};
const two: Widget = {
  id: '2',
  workspaceId: 'a',
  name: 'two',
  rank: 2,
  secret: 's2',
};

const item = (entity: Widget): WidgetListItem => ({
  id: entity.id,
  label: entity.name,
  rank: entity.rank,
});

function handlers(
  shape: EntityCacheListShape,
  updateMissing: 'skip' | 'insert' = 'skip',
  createAt: 'start' | 'end' = 'start',
) {
  return createEntityCacheHandlers<Widget, WidgetListItem>({
    getId: (entity) => entity.id,
    getListItemId: (entry) => entry.id,
    toListItem: item,
    list: {
      key: ['widgets'],
      shape,
      createAt,
      updateMissing,
      compare: (left, right) => left.rank - right.rank,
    },
    detailKey: (event) => ['widgets', event.id],
  });
}

function context(queryClient: QueryClient, fresh: string[] = []): CacheBridgeContext {
  const freshKeys = new Set(fresh.map((id) => JSON.stringify(['widgets', id])));
  return {
    queryClient,
    isFresh: (key) => freshKeys.has(JSON.stringify(key)),
  };
}

describe('createEntityCacheHandlers list-shape matrix', () => {
  test('array: projection, ordering, duplicate create and explicit missing-update policy', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData<WidgetListItem[]>(['widgets'], [item(one), item(two)]);
    const cache = handlers('array');
    const zero = { ...one, id: '0', name: 'zero', rank: 0 };

    cache.created(zero, context(queryClient));
    cache.created({ ...zero, name: 'duplicate' }, context(queryClient));
    cache.updated({ ...two, name: 'TWO', rank: -1 }, context(queryClient));
    cache.updated({ ...one, id: 'missing', name: 'missing' }, context(queryClient));

    expect(queryClient.getQueryData<WidgetListItem[]>(['widgets'])).toEqual([
      { id: '2', label: 'TWO', rank: -1 },
      { id: '0', label: 'zero', rank: 0 },
      { id: '1', label: 'one', rank: 1 },
    ]);
    expect(queryClient.getQueryData<Widget>(['widgets', '2'])).toEqual({
      ...two,
      name: 'TWO',
      rank: -1,
    });

    const inserting = handlers('array', 'insert', 'end');
    inserting.updated({ ...one, id: '3', name: 'three', rank: 3 }, context(queryClient));
    expect(
      queryClient.getQueryData<WidgetListItem[]>(['widgets'])?.map((entry) => entry.id),
    ).toEqual(['2', '0', '1', '3']);
  });

  test('paginated: CRUD preserves cursor and extra envelope metadata', () => {
    const queryClient = new QueryClient();
    const page: Paginated<WidgetListItem> & { total: number } = {
      items: [item(one), item(two)],
      nextCursor: 'cursor',
      total: 19,
    };
    queryClient.setQueryData(['widgets'], page);
    const cache = handlers('paginated');

    cache.created({ ...one, id: '3', name: 'three', rank: 3 }, context(queryClient));
    cache.updated({ ...one, name: 'ONE', rank: 4 }, context(queryClient));
    cache.deleted({ id: '2' }, context(queryClient));

    expect(
      queryClient.getQueryData<Paginated<WidgetListItem> & { total: number }>(['widgets']),
    ).toEqual({
      items: [
        { id: '3', label: 'three', rank: 3 },
        { id: '1', label: 'ONE', rank: 4 },
      ],
      nextCursor: 'cursor',
      total: 19,
    });
  });

  test('infinite arrays: updates/deletes cross pages and insertion chooses one edge page', () => {
    const queryClient = new QueryClient();
    const data: InfiniteData<WidgetListItem[]> = {
      pages: [[item(one)], [item(two)]],
      pageParams: [undefined, 'cursor'],
    };
    queryClient.setQueryData(['widgets'], data);
    const cache = handlers('infinite-array', 'insert', 'end');

    cache.created({ ...one, id: '3', name: 'three', rank: 3 }, context(queryClient));
    cache.updated({ ...one, name: 'ONE', rank: 4 }, context(queryClient));
    cache.updated({ ...one, id: '0', name: 'zero', rank: 0 }, context(queryClient));
    cache.deleted(two, context(queryClient));

    expect(queryClient.getQueryData<InfiniteData<WidgetListItem[]>>(['widgets'])).toEqual({
      pages: [
        [{ id: '1', label: 'ONE', rank: 4 }],
        [
          { id: '0', label: 'zero', rank: 0 },
          { id: '3', label: 'three', rank: 3 },
        ],
      ],
      pageParams: [undefined, 'cursor'],
    });
  });

  test('infinite paginated: page envelopes and pageParams survive every mutation', () => {
    const queryClient = new QueryClient();
    const data: InfiniteData<Paginated<WidgetListItem> & { marker: string }> = {
      pages: [
        { items: [item(one)], nextCursor: 'c1', marker: 'first' },
        { items: [item(two)], nextCursor: null, marker: 'last' },
      ],
      pageParams: [undefined, 'c1'],
    };
    queryClient.setQueryData(['widgets'], data);
    const cache = handlers('infinite-paginated');

    cache.created({ ...one, id: '0', name: 'zero', rank: 0 }, context(queryClient));
    cache.updated({ ...two, name: 'TWO', rank: -1 }, context(queryClient));
    cache.deleted({ id: '1' }, context(queryClient));

    expect(
      queryClient.getQueryData<InfiniteData<Paginated<WidgetListItem> & { marker: string }>>([
        'widgets',
      ]),
    ).toEqual({
      pages: [
        {
          items: [{ id: '0', label: 'zero', rank: 0 }],
          nextCursor: 'c1',
          marker: 'first',
        },
        {
          items: [{ id: '2', label: 'TWO', rank: -1 }],
          nextCursor: null,
          marker: 'last',
        },
      ],
      pageParams: [undefined, 'c1'],
    });
  });
});

function workspaceKey(event: EntityCacheEvent<Widget>): readonly unknown[] {
  if (event.type !== 'deleted') return ['workspace', event.entity.workspaceId, 'widgets'];
  if ('workspaceId' in event.payload && typeof event.payload.workspaceId === 'string') {
    return ['workspace', event.payload.workspaceId, 'widgets'];
  }
  throw new Error('A scoped delete event must carry its entity');
}

describe('scoped keys, detail cache and echo guard', () => {
  test('dynamic keys patch only the event workspace', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData<WidgetListItem[]>(['workspace', 'a', 'widgets'], [item(one)]);
    queryClient.setQueryData<WidgetListItem[]>(
      ['workspace', 'b', 'widgets'],
      [{ id: 'b1', label: 'other', rank: 1 }],
    );
    const cache = createEntityCacheHandlers<Widget, WidgetListItem>({
      getId: (entity) => entity.id,
      getListItemId: (entry) => entry.id,
      toListItem: item,
      list: {
        key: workspaceKey,
        shape: 'array',
        createAt: 'start',
        updateMissing: 'skip',
      },
      detailKey: (event) => [...workspaceKey(event), event.id],
    });

    cache.updated({ ...one, name: 'ONE' }, context(queryClient));

    expect(queryClient.getQueryData<WidgetListItem[]>(['workspace', 'a', 'widgets'])).toEqual([
      { id: '1', label: 'ONE', rank: 1 },
    ]);
    expect(queryClient.getQueryData<WidgetListItem[]>(['workspace', 'b', 'widgets'])).toEqual([
      { id: 'b1', label: 'other', rank: 1 },
    ]);
    expect(queryClient.getQueryData<Widget>(['workspace', 'a', 'widgets', '1'])).toEqual({
      ...one,
      name: 'ONE',
    });
  });

  test('fresh detail key skips list and detail writes together', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData<WidgetListItem[]>(['widgets'], [item(one)]);
    handlers('array').updated({ ...one, name: 'echo' }, context(queryClient, ['1']));

    expect(queryClient.getQueryData<WidgetListItem[]>(['widgets'])).toEqual([item(one)]);
    expect(queryClient.getQueryData(['widgets', '1'])).toBeUndefined();
  });

  test('custom deleted id remains authoritative', () => {
    interface LegacyEntity {
      key: string;
      name: string;
    }
    const queryClient = new QueryClient();
    queryClient.setQueryData<LegacyEntity[]>(['legacy'], [{ key: 'x', name: 'one' }]);
    const cache = createEntityCacheHandlers<LegacyEntity>({
      getId: (entity) => entity.key,
      getListItemId: (entry) => entry.key,
      toListItem: (entity) => entity,
      getDeletedId: (payload) => ('key' in payload ? payload.key : payload.id),
      list: {
        key: ['legacy'],
        shape: 'array',
        createAt: 'start',
        updateMissing: 'skip',
      },
    });

    cache.deleted({ key: 'x', name: 'one' }, context(queryClient));
    expect(queryClient.getQueryData<LegacyEntity[]>(['legacy'])).toEqual([]);
  });
});
