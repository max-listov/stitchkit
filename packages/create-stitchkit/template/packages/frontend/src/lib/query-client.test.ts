import { describe, expect, test } from 'bun:test';
import { getQueryClient } from './query-client';

describe('query dehydration policy', () => {
  test('includes successful prefetched data and pending streamed queries', () => {
    const queryClient = getQueryClient();
    queryClient.setQueryData(['prefetched-project'], { id: 'project-1' });
    void queryClient.prefetchQuery({
      queryKey: ['pending-project'],
      queryFn: () => new Promise(() => undefined),
    });

    const shouldDehydrate = queryClient.getDefaultOptions().dehydrate?.shouldDehydrateQuery;
    if (!shouldDehydrate) throw new Error('dehydration policy is required');
    const successful = queryClient.getQueryCache().find({ queryKey: ['prefetched-project'] });
    const pending = queryClient.getQueryCache().find({ queryKey: ['pending-project'] });
    if (!successful || !pending) throw new Error('test queries were not created');

    expect(shouldDehydrate(successful)).toBe(true);
    expect(shouldDehydrate(pending)).toBe(true);
  });

  test('retries a query once and never retries a mutation', () => {
    const defaults = getQueryClient().getDefaultOptions();
    expect(defaults.queries?.retry).toBe(1);
    expect(defaults.mutations?.retry).toBe(false);
  });
});
