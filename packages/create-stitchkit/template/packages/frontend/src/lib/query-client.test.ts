import { describe, expect, test } from 'bun:test';
import { ApiError } from 'stitchkit';
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

  test('retries a server failure once and never retries a mutation', () => {
    // Asserted through the decision, not through the literal: the policy is a
    // predicate now, and `retry === 1` would pass for a client that retries an
    // unauthorized request too.
    const defaults = getQueryClient().getDefaultOptions();
    const retry = defaults.queries?.retry;
    if (typeof retry !== 'function') throw new Error('query retry policy is required');
    const serverFailure = new ApiError('INTERNAL_SERVER_ERROR', 500);
    expect(retry(0, serverFailure)).toBe(true);
    expect(retry(1, serverFailure)).toBe(false);
    expect(defaults.mutations?.retry).toBe(false);
  });

  test('a request the user cannot repeat into success is not retried', () => {
    const defaults = getQueryClient().getDefaultOptions();
    const retry = defaults.queries?.retry;
    if (typeof retry !== 'function') throw new Error('query retry policy is required');
    for (const code of ['UNAUTHORIZED', 'FORBIDDEN', 'VALIDATION_ERROR']) {
      expect(retry(0, new ApiError(code, 401))).toBe(false);
    }
  });
});
