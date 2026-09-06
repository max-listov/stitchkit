import {
  defaultShouldDehydrateQuery,
  environmentManager,
  MutationCache,
  type MutationCacheConfig,
  QueryClient,
  type QueryClientConfig,
} from '@tanstack/react-query';
import { ApiError, isAbortLikeError } from '../browser/http';

export interface ApiErrorRetryConfig {
  /** Maximum retries after the initial query attempt. */
  attempts?: number;
  /** Application codes which are never retried. */
  never?: readonly string[];
  /** Inclusive HTTP status ranges which are retryable. */
  statusRanges?: readonly (readonly [from: number, to: number])[];
  /** Whether an unclassified non-API error is treated as a network failure. */
  network?: boolean;
}

const DEFAULT_NEVER_RETRY = [
  'UNAUTHORIZED',
  'FORBIDDEN',
  'VALIDATION_ERROR',
  'REQUEST_ABORTED',
] as const;

/** Build a React Query retry predicate from Stitchkit's cross-bundle API error model. */
export function apiErrorRetry(config: ApiErrorRetryConfig = {}) {
  const attempts = config.attempts ?? 1;
  if (!Number.isSafeInteger(attempts) || attempts < 0) {
    throw new Error(
      `apiErrorRetry attempts must be a non-negative safe integer, received ${attempts}`,
    );
  }
  const never = new Set(config.never ?? DEFAULT_NEVER_RETRY);
  const statusRanges = config.statusRanges ?? [[500, 599]];
  for (const [from, to] of statusRanges) {
    if (
      !Number.isSafeInteger(from) ||
      !Number.isSafeInteger(to) ||
      from < 100 ||
      to > 599 ||
      from > to
    ) {
      throw new Error(
        `apiErrorRetry status range must be an inclusive HTTP range, received ${from}..${to}`,
      );
    }
  }

  return (failureCount: number, error: unknown): boolean => {
    if (failureCount >= attempts) return false;
    if (isAbortLikeError(error)) return false;
    if (!ApiError.is(error)) return config.network ?? true;
    if (never.has(error.code)) return false;
    if (error.status === 0) return config.network ?? true;
    return statusRanges.some(([from, to]) => error.status >= from && error.status <= to);
  };
}

export type QueryClientServerCache = (factory: () => QueryClient) => () => QueryClient;
export type QueryRetryValue = NonNullable<
  NonNullable<QueryClientConfig['defaultOptions']>['queries']
>['retry'];

export interface QueryClientFactoryConfig {
  /** Full TanStack QueryClient config; defaults are merged by section. */
  queryClient?: QueryClientConfig;
  /** Query retry policy; mutations remain non-retryable unless explicitly overridden. */
  retry?: ApiErrorRetryConfig | QueryRetryValue;
  /** Optional shared mutation error observer. */
  onMutationError?: MutationCacheConfig['onError'];
  /** Request-local cache adapter, normally React's `cache`. */
  serverCache?: QueryClientServerCache;
  /** Deterministic environment seam; defaults to TanStack's environment manager. */
  server?: () => boolean;
}

/**
 * Create one request-local server QueryClient and one factory-local browser singleton.
 * No server cache is invented: the host supplies React `cache` (or an equivalent adapter).
 */
export function createQueryClientFactory(
  config: QueryClientFactoryConfig = {},
): () => QueryClient {
  const supplied = config.queryClient ?? {};
  if (config.onMutationError && supplied.mutationCache) {
    throw new Error(
      'createQueryClientFactory cannot combine onMutationError with queryClient.mutationCache',
    );
  }
  const suppliedDefaults = supplied.defaultOptions ?? {};
  const queryRetry =
    typeof config.retry === 'object' || config.retry === undefined
      ? apiErrorRetry(config.retry)
      : config.retry;

  const create = (): QueryClient =>
    new QueryClient({
      ...supplied,
      ...(config.onMutationError
        ? { mutationCache: new MutationCache({ onError: config.onMutationError }) }
        : {}),
      defaultOptions: {
        ...suppliedDefaults,
        queries: {
          ...suppliedDefaults.queries,
          retry: suppliedDefaults.queries?.retry ?? queryRetry,
        },
        mutations: {
          ...suppliedDefaults.mutations,
          retry: suppliedDefaults.mutations?.retry ?? false,
        },
        dehydrate: {
          ...suppliedDefaults.dehydrate,
          shouldDehydrateQuery:
            suppliedDefaults.dehydrate?.shouldDehydrateQuery ??
            ((query) =>
              defaultShouldDehydrateQuery(query) || query.state.status === 'pending'),
        },
      },
    });

  const getServer = config.serverCache ? config.serverCache(create) : create;
  const isServer = config.server ?? (() => environmentManager.isServer());
  let browserClient: QueryClient | undefined;

  return () => {
    if (isServer()) return getServer();
    browserClient ??= create();
    return browserClient;
  };
}
