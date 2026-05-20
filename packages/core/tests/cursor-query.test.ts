import { describe, expect, test } from 'bun:test';
import { createCursorQuery } from '../src/react/cursor-query';

interface Page {
  items: number[];
  nextCursor: string | null;
}

describe('createCursorQuery', () => {
  test('fetcher injects cursor from the page param', async () => {
    const seen: Array<{ tag: string; cursor?: string }> = [];
    const endpoint = async (args: { tag: string; cursor?: string }): Promise<Page> => {
      seen.push(args);
      return { items: [1], nextCursor: 'next' };
    };
    const useFeed = createCursorQuery<{ tag: string }, Page>({
      queryKey: ['feed'],
      endpoint,
    });

    await useFeed.fetcher({ tag: 'a' }, { pageParam: 'cur-1' });

    expect(seen).toEqual([{ tag: 'a', cursor: 'cur-1' }]);
  });

  test('fetcher sends no cursor for the initial (null) page', async () => {
    const seen: Array<{ tag: string; cursor?: string }> = [];
    const endpoint = async (args: { tag: string; cursor?: string }): Promise<Page> => {
      seen.push(args);
      return { items: [], nextCursor: null };
    };
    const useFeed = createCursorQuery<{ tag: string }, Page>({
      queryKey: ['feed'],
      endpoint,
    });

    await useFeed.fetcher({ tag: 'b' }, { pageParam: null });

    expect(seen).toEqual([{ tag: 'b', cursor: undefined }]);
  });

  test('getFetchOptions bakes in initialPageParam and getNextPageParam', () => {
    const endpoint = async (): Promise<Page> => ({ items: [], nextCursor: null });
    const useFeed = createCursorQuery<void, Page>({ queryKey: ['feed'], endpoint });

    const opts = useFeed.getFetchOptions();

    expect(opts.initialPageParam).toBeNull();
    expect(opts.getNextPageParam({ items: [], nextCursor: 'abc' }, [], 'abc', [])).toBe('abc');
    expect(opts.getNextPageParam({ items: [], nextCursor: null }, [], null, [])).toBeNull();
  });
});
