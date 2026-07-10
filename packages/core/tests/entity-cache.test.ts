/**
 * `createEntityCacheHandlers` — created / updated / deleted patched into a
 * `Paginated<T>` list (plain and infinite) and the detail query. It keeps the
 * cache correct without flattening pages.
 */
import { describe, expect, test } from 'bun:test';
import { type InfiniteData, QueryClient } from '@tanstack/react-query';
import type { Paginated } from '../src/contract';
import type { CacheBridgeContext } from '../src/react';
import { createEntityCacheHandlers } from '../src/react';

interface Widget {
  id: string;
  name: string;
}

const handlers = createEntityCacheHandlers<Widget>({
  getId: (w) => w.id,
  listKey: ['widgets'],
  detailKey: (id) => ['widgets', id],
});

/** A bridge context whose `isFresh` is off unless a key list says otherwise. */
function makeCtx(queryClient: QueryClient, freshKeys: string[] = []): CacheBridgeContext {
  const fresh = new Set(freshKeys.map((k) => JSON.stringify(['widgets', k])));
  return { queryClient, isFresh: (key) => fresh.has(JSON.stringify(key)) };
}

describe('createEntityCacheHandlers — plain Paginated list', () => {
  function seed(): QueryClient {
    const qc = new QueryClient();
    const page: Paginated<Widget> = {
      items: [
        { id: '1', name: 'one' },
        { id: '2', name: 'two' },
      ],
      nextCursor: null,
    };
    qc.setQueryData(['widgets'], page);
    return qc;
  }

  test('created prepends to the list and seeds the detail query', () => {
    const qc = seed();
    handlers.created({ id: '3', name: 'three' }, makeCtx(qc));
    const list = qc.getQueryData<Paginated<Widget>>(['widgets']);
    expect(list?.items.map((w) => w.id)).toEqual(['3', '1', '2']);
    expect(qc.getQueryData<Widget>(['widgets', '3'])).toEqual({ id: '3', name: 'three' });
  });

  test('created is idempotent — a duplicate id is not added twice', () => {
    const qc = seed();
    handlers.created({ id: '1', name: 'one-again' }, makeCtx(qc));
    const list = qc.getQueryData<Paginated<Widget>>(['widgets']);
    expect(list?.items.map((w) => w.id)).toEqual(['1', '2']);
  });

  test('updated replaces the matching item and the detail query', () => {
    const qc = seed();
    handlers.updated({ id: '2', name: 'TWO' }, makeCtx(qc));
    const list = qc.getQueryData<Paginated<Widget>>(['widgets']);
    expect(list?.items.find((w) => w.id === '2')?.name).toBe('TWO');
    expect(qc.getQueryData<Widget>(['widgets', '2'])).toEqual({ id: '2', name: 'TWO' });
  });

  test('deleted removes the item (accepts a bare { id })', () => {
    const qc = seed();
    handlers.deleted({ id: '1' }, makeCtx(qc));
    const list = qc.getQueryData<Paginated<Widget>>(['widgets']);
    expect(list?.items.map((w) => w.id)).toEqual(['2']);
  });

  test('a fresh key (just mutated) skips the echo', () => {
    const qc = seed();
    handlers.updated({ id: '2', name: 'echo' }, makeCtx(qc, ['2']));
    const list = qc.getQueryData<Paginated<Widget>>(['widgets']);
    // Unchanged — the socket echo was skipped.
    expect(list?.items.find((w) => w.id === '2')?.name).toBe('two');
  });
});

describe('createEntityCacheHandlers — infinite list', () => {
  function seed(): QueryClient {
    const qc = new QueryClient();
    const data: InfiniteData<Paginated<Widget>> = {
      pages: [
        { items: [{ id: '1', name: 'one' }], nextCursor: 'c1' },
        { items: [{ id: '2', name: 'two' }], nextCursor: null },
      ],
      pageParams: [undefined, 'c1'],
    };
    qc.setQueryData(['widgets'], data);
    return qc;
  }

  test('created prepends to the first page only', () => {
    const qc = seed();
    handlers.created({ id: '3', name: 'three' }, makeCtx(qc));
    const data = qc.getQueryData<InfiniteData<Paginated<Widget>>>(['widgets']);
    expect(data?.pages[0]?.items.map((w) => w.id)).toEqual(['3', '1']);
    expect(data?.pages[1]?.items.map((w) => w.id)).toEqual(['2']);
  });

  test('updated replaces across pages', () => {
    const qc = seed();
    handlers.updated({ id: '2', name: 'TWO' }, makeCtx(qc));
    const data = qc.getQueryData<InfiniteData<Paginated<Widget>>>(['widgets']);
    expect(data?.pages[1]?.items[0]?.name).toBe('TWO');
  });

  test('deleted removes across pages', () => {
    const qc = seed();
    handlers.deleted({ id: '1', name: 'one' }, makeCtx(qc));
    const data = qc.getQueryData<InfiniteData<Paginated<Widget>>>(['widgets']);
    expect(data?.pages[0]?.items).toEqual([]);
    expect(data?.pages[1]?.items.map((w) => w.id)).toEqual(['2']);
  });
});
