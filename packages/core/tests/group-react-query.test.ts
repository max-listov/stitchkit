import { describe, expect, test } from 'bun:test';
import { MutationCache } from '@tanstack/react-query';
import { ApiError } from '../src/browser/http';
import { apiErrorRetry, createQueryClientFactory } from '../src/react/query-client';

describe('apiErrorRetry', () => {
  const retry = apiErrorRetry({ attempts: 2 });

  test('retries network and 5xx query failures within the budget', () => {
    expect(retry(0, new Error('offline'))).toBe(true);
    expect(retry(0, new ApiError('UPSTREAM', 503))).toBe(true);
    expect(retry(2, new ApiError('UPSTREAM', 503))).toBe(false);
  });

  test('does not retry authorization, validation or 4xx failures', () => {
    expect(retry(0, new ApiError('UNAUTHORIZED', 401))).toBe(false);
    expect(retry(0, new ApiError('VALIDATION_ERROR', 0))).toBe(false);
    expect(retry(0, new ApiError('MISSING', 404))).toBe(false);
    expect(retry(0, new DOMException('cancelled', 'AbortError'))).toBe(false);
    expect(retry(0, { name: 'TimeoutError' })).toBe(false);
  });

  test('attempts stops query retries at the declared budget', () => {
    expect(apiErrorRetry({ attempts: 0 })(0, new Error('offline'))).toBe(false);
  });

  test('never excludes an application error code from retries', () => {
    expect(apiErrorRetry({ never: ['BUSY'] })(0, new ApiError('BUSY', 503))).toBe(false);
  });

  test('statusRanges chooses the inclusive retryable HTTP range', () => {
    const selected = apiErrorRetry({ statusRanges: [[408, 408]] });
    expect(selected(0, new ApiError('TIMEOUT', 408))).toBe(true);
    expect(selected(0, new ApiError('UPSTREAM', 503))).toBe(false);
  });

  test('network false refuses an unclassified transport failure', () => {
    expect(apiErrorRetry({ network: false })(0, new Error('offline'))).toBe(false);
  });
});

describe('createQueryClientFactory', () => {
  test('keeps browser singletons local to each factory', () => {
    const first = createQueryClientFactory({ server: () => false });
    const second = createQueryClientFactory({ server: () => false });
    expect(first()).toBe(first());
    expect(second()).toBe(second());
    expect(first()).not.toBe(second());
  });

  test('delegates server identity to the supplied request cache', () => {
    const cache = (factory: () => ReturnType<ReturnType<typeof createQueryClientFactory>>) => {
      let value: ReturnType<typeof factory> | undefined;
      return () => (value ??= factory());
    };
    const get = createQueryClientFactory({ server: () => true, serverCache: cache });
    expect(get()).toBe(get());
  });

  test('keeps mutations non-retryable and pending dehydration enabled', () => {
    const client = createQueryClientFactory({ server: () => true })();
    expect(client.getDefaultOptions().mutations?.retry).toBe(false);
    const shouldDehydrate = client.getDefaultOptions().dehydrate?.shouldDehydrateQuery;
    void client.prefetchQuery({
      queryKey: ['pending'],
      queryFn: () => new Promise(() => undefined),
    });
    const pending = client.getQueryCache().find({ queryKey: ['pending'] });
    if (!shouldDehydrate || !pending) throw new Error('pending query fixture was not created');
    expect(shouldDehydrate(pending)).toBe(true);
  });

  test('queryClient defaults are preserved by the factory', () => {
    const client = createQueryClientFactory({
      server: () => true,
      queryClient: { defaultOptions: { queries: { staleTime: 123 } } },
    })();
    expect(client.getDefaultOptions().queries?.staleTime).toBe(123);
  });

  test('retry config becomes the default query retry predicate', () => {
    const client = createQueryClientFactory({ server: () => true, retry: { attempts: 0 } })();
    const retry = client.getDefaultOptions().queries?.retry;
    if (typeof retry !== 'function') throw new Error('retry predicate was not installed');
    expect(retry(0, new Error('offline'))).toBe(false);
  });

  test('onMutationError is installed on the mutation cache', () => {
    const onMutationError = () => undefined;
    const client = createQueryClientFactory({ server: () => true, onMutationError })();
    expect(client.getMutationCache().config.onError).toBe(onMutationError);
  });

  test('onMutationError refuses to replace a caller-supplied mutation cache', () => {
    const existing = new MutationCache();
    expect(() =>
      createQueryClientFactory({
        queryClient: { mutationCache: existing },
        onMutationError: () => undefined,
      }),
    ).toThrow('cannot combine onMutationError with queryClient.mutationCache');
  });

  test('serverCache owns request-local QueryClient identity', () => {
    let calls = 0;
    const get = createQueryClientFactory({
      server: () => true,
      serverCache: (factory) => {
        let value: ReturnType<typeof factory> | undefined;
        return () => {
          calls += 1;
          if (!value) value = factory();
          return value;
        };
      },
    });
    expect(get()).toBe(get());
    expect(calls).toBe(2);
  });

  test('server selector chooses request cache or browser singleton', () => {
    let server = true;
    const get = createQueryClientFactory({ server: () => server });
    expect(get()).not.toBe(get());
    server = false;
    expect(get()).toBe(get());
  });
});
