import { abortReason, raceAbort } from '../internal/abort-race';
import { assertTimerMs } from '../internal/deadline';
import { assertPositiveSafeInteger } from '../internal/positive-integer';
import {
  loadOpenRouterCatalogSnapshot,
  type OpenRouterCatalogSnapshot,
  OpenRouterCatalogSnapshotSchema,
  type OpenRouterSnapshotModel,
  type OpenRouterSnapshotOptions,
} from './openrouter-catalog';
import {
  findOpenRouterModel,
  listOpenRouterModels,
  type OpenRouterModelFilter,
  validateOpenRouterModelFilter,
} from './openrouter-catalog-query';
import {
  assertValidOpenRouterEndpointsFor,
  assertValidStaticOpenRouterApiKey,
} from './openrouter-models';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_FRESH_MS = 15 * 60_000;
const DEFAULT_RETRY_BACKOFF_MS = 60_000;
const DEFAULT_CONCURRENCY = 4;

/** Persistence port for caching an {@link OpenRouterCatalogSnapshot} outside memory (Web Fetch-clean). */
export interface OpenRouterCatalogStore {
  read(): Promise<OpenRouterCatalogSnapshot | null> | OpenRouterCatalogSnapshot | null;
  write(snapshot: OpenRouterCatalogSnapshot): Promise<void> | void;
}

/** Options for {@link createOpenRouterCatalogCache}. */
export interface OpenRouterCatalogCacheOptions
  extends Omit<OpenRouterSnapshotOptions, 'signal'> {
  /** How long a snapshot remains `current` before the next read refreshes. Default 15 min. */
  readonly freshMs?: number;
  /** Wait window after a failed upstream refresh before retrying automatically. Default 60 s. */
  readonly retryBackoffMs?: number;
  /** Optional persistence store hydrated on first read and written after successful refreshes. */
  readonly store?: OpenRouterCatalogStore;
  /** Observer called when store hydration, store persistence, or upstream refresh fails. */
  readonly onError?: (error: unknown) => void;
}

/** Outcome of reading from an {@link OpenRouterCatalogCache}, discriminated by `status`. */
export type OpenRouterCatalogCacheReadResult =
  | {
      readonly status: 'current';
      readonly observedAt: string;
      readonly snapshot: OpenRouterCatalogSnapshot;
      readonly models: readonly OpenRouterSnapshotModel[];
      readonly lastError?: undefined;
    }
  | {
      readonly status: 'stale';
      readonly observedAt: string;
      readonly snapshot: OpenRouterCatalogSnapshot;
      readonly models: readonly OpenRouterSnapshotModel[];
      readonly lastError?: unknown;
    }
  | {
      readonly status: 'unavailable';
      readonly observedAt: null;
      readonly snapshot: null;
      readonly models: readonly [];
      readonly lastError?: unknown;
    };

/** Cached OpenRouter catalog reader with single-flight coalescing, TTL, retry backoff, and optional persistence. */
export interface OpenRouterCatalogCache {
  read(input?: {
    readonly signal?: AbortSignal;
    readonly forceRefresh?: boolean;
  }): Promise<OpenRouterCatalogCacheReadResult>;
  refresh(input?: {
    readonly signal?: AbortSignal;
  }): Promise<OpenRouterCatalogCacheReadResult>;
  /**
   * Look up one model by `id` or `canonicalSlug`.
   * Returns `undefined` when the model is absent or when the cache `status` is `'unavailable'`.
   * Admission and billing callers must use {@link read} to observe `'stale'` and `'unavailable'` explicitly.
   */
  getModel(
    idOrSlug: string,
    input?: { readonly signal?: AbortSignal },
  ): Promise<OpenRouterSnapshotModel | undefined>;
  /**
   * List models matching `filter`.
   * Returns `[]` when no model matches or when the cache `status` is `'unavailable'`.
   * Admission and billing callers must use {@link read} to observe `'stale'` and `'unavailable'` explicitly.
   */
  listModels(
    filter?: OpenRouterModelFilter,
    input?: { readonly signal?: AbortSignal },
  ): Promise<readonly OpenRouterSnapshotModel[]>;
}

interface InFlightRefresh {
  readonly controller: AbortController;
  readonly promise: Promise<{ readonly succeeded: boolean }>;
  waiters: number;
}

async function waitForCatalogFlight(
  flight: InFlightRefresh,
  signal: AbortSignal | undefined,
  onOrphanCancel: (flight: InFlightRefresh, reason: unknown) => void,
): Promise<{ readonly succeeded: boolean }> {
  flight.waiters += 1;
  let released = false;
  const detach = (cancelReason?: unknown): void => {
    if (released) return;
    released = true;
    flight.waiters -= 1;
    if (flight.waiters === 0 && cancelReason !== undefined) {
      onOrphanCancel(flight, cancelReason);
    }
  };
  if (!signal) {
    try {
      return await flight.promise;
    } finally {
      detach();
    }
  }
  const onAbort = (): void => {
    detach(abortReason(signal));
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await raceAbort(flight.promise, signal);
  } finally {
    signal.removeEventListener('abort', onAbort);
    detach();
  }
}

async function readStoredSnapshot(
  store: OpenRouterCatalogStore,
  notifyError: (error: unknown) => void,
): Promise<OpenRouterCatalogSnapshot | null> {
  try {
    const raw = await store.read();
    if (raw === null || raw === undefined) return null;
    const parsed = OpenRouterCatalogSnapshotSchema.safeParse(raw);
    if (parsed.success) return parsed.data;
    notifyError(parsed.error);
    return null;
  } catch (error) {
    notifyError(error);
    return null;
  }
}

function validateCacheOptions(options: OpenRouterCatalogCacheOptions): {
  readonly timeoutMs: number;
  readonly freshMs: number;
  readonly retryBackoffMs: number;
  readonly concurrency: number;
  readonly endpointsFor?: string[];
} {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const freshMs = options.freshMs ?? DEFAULT_FRESH_MS;
  const retryBackoffMs = options.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  assertTimerMs('timeoutMs', timeoutMs, { absent: 'refused' });
  assertTimerMs('freshMs', freshMs, { absent: 'refused' });
  assertTimerMs('retryBackoffMs', retryBackoffMs, { absent: 'refused' });
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) {
    throw new RangeError('concurrency must be an integer from 1 to 16');
  }
  if (options.maxResponseBytes !== undefined) {
    assertPositiveSafeInteger('maxResponseBytes', options.maxResponseBytes, RangeError);
  }
  assertValidStaticOpenRouterApiKey(options.apiKey);
  assertValidOpenRouterEndpointsFor(options.endpointsFor);
  return {
    timeoutMs,
    freshMs,
    retryBackoffMs,
    concurrency,
    ...(options.endpointsFor !== undefined && { endpointsFor: [...options.endpointsFor] }),
  };
}

/**
 * Create a Web Fetch-clean OpenRouter catalog cache with single-flight coalescing,
 * TTL freshness, retry backoff, stale fallback, and an optional pluggable persistence store.
 */
export function createOpenRouterCatalogCache(
  options: OpenRouterCatalogCacheOptions = {},
): OpenRouterCatalogCache {
  const { timeoutMs, freshMs, retryBackoffMs, concurrency, endpointsFor } =
    validateCacheOptions(options);
  const now = options.now ?? (() => new Date());

  let snapshot: OpenRouterCatalogSnapshot | null = null;
  let hasLastError = false;
  let lastError: unknown;
  let nextRetryAtMs: number | null = null;
  let hydrated = false;
  let hydrationPromise: Promise<void> | null = null;
  let inFlight: InFlightRefresh | null = null;
  let latestGeneration = 0;
  let committedGeneration = 0;
  let writeChain: Promise<void> = Promise.resolve();

  const notifyError = (error: unknown): void => {
    try {
      options.onError?.(error);
    } catch {
      // Observer failures must not disrupt fallback reads.
    }
  };

  const isSnapshotFresh = (candidate: OpenRouterCatalogSnapshot, nowMs: number): boolean => {
    const ageMs = nowMs - Date.parse(candidate.observedAt);
    return ageMs >= 0 && ageMs < freshMs;
  };

  const buildResult = (forceCurrent = false): OpenRouterCatalogCacheReadResult => {
    if (snapshot === null) {
      return {
        status: 'unavailable',
        observedAt: null,
        snapshot: null,
        models: [],
        ...(hasLastError && { lastError }),
      };
    }
    const current =
      forceCurrent || (!hasLastError && isSnapshotFresh(snapshot, now().getTime()));
    return current
      ? {
          status: 'current',
          observedAt: snapshot.observedAt,
          snapshot,
          models: snapshot.models,
        }
      : {
          status: 'stale',
          observedAt: snapshot.observedAt,
          snapshot,
          models: snapshot.models,
          ...(hasLastError && { lastError }),
        };
  };

  const ensureHydrated = (signal: AbortSignal | undefined): Promise<void> => {
    if (hydrated) return Promise.resolve();
    const store = options.store;
    if (!store) {
      hydrated = true;
      return Promise.resolve();
    }
    hydrationPromise ??= readStoredSnapshot(store, notifyError)
      .then((loaded) => {
        if (loaded !== null && snapshot === null) snapshot = loaded;
      })
      .finally(() => {
        hydrated = true;
        hydrationPromise = null;
      });
    return signal ? raceAbort(hydrationPromise, signal) : hydrationPromise;
  };

  const persistSnapshot = (
    generation: number,
    loaded: OpenRouterCatalogSnapshot,
  ): Promise<void> => {
    const store = options.store;
    if (!store) return Promise.resolve();
    const writeStep = writeChain.then(async () => {
      if (generation < committedGeneration) return;
      try {
        await store.write(loaded);
      } catch (storeError) {
        notifyError(storeError);
      }
    });
    writeChain = writeStep;
    return writeStep;
  };

  const startFlight = (): InFlightRefresh => {
    latestGeneration += 1;
    const generation = latestGeneration;
    const controller = new AbortController();
    const flight: InFlightRefresh = {
      controller,
      waiters: 0,
      promise: Promise.resolve().then(async () => {
        try {
          const loaded = await loadOpenRouterCatalogSnapshot({
            ...options,
            timeoutMs,
            concurrency,
            ...(endpointsFor !== undefined && { endpointsFor }),
            signal: controller.signal,
            now,
          });
          if (controller.signal.aborted || generation < committedGeneration) {
            return { succeeded: false };
          }
          committedGeneration = generation;
          snapshot = loaded;
          hasLastError = false;
          lastError = undefined;
          nextRetryAtMs = null;
          await persistSnapshot(generation, loaded);
          return { succeeded: true };
        } catch (error) {
          if (!controller.signal.aborted && generation >= committedGeneration) {
            hasLastError = true;
            lastError = error;
            nextRetryAtMs = now().getTime() + retryBackoffMs;
            notifyError(error);
          }
          return { succeeded: false };
        } finally {
          if (inFlight === flight) inFlight = null;
        }
      }),
    };
    inFlight = flight;
    return flight;
  };

  const cancelOrphanedFlight = (flight: InFlightRefresh, reason: unknown): void => {
    if (inFlight === flight) inFlight = null;
    flight.controller.abort(reason);
  };

  const read = async (
    input: { readonly signal?: AbortSignal; readonly forceRefresh?: boolean } = {},
  ): Promise<OpenRouterCatalogCacheReadResult> => {
    if (input.signal?.aborted) throw abortReason(input.signal);
    await ensureHydrated(input.signal);
    if (input.signal?.aborted) throw abortReason(input.signal);

    const forceRefresh = input.forceRefresh === true;
    const nowMs = now().getTime();

    if (!forceRefresh) {
      if (snapshot !== null && !hasLastError && isSnapshotFresh(snapshot, nowMs)) {
        return buildResult();
      }
      if (inFlight === null && nextRetryAtMs !== null && nowMs < nextRetryAtMs) {
        return buildResult();
      }
    }

    const flight = inFlight ?? startFlight();
    const outcome = await waitForCatalogFlight(flight, input.signal, cancelOrphanedFlight);
    return buildResult(outcome.succeeded);
  };

  return {
    read,
    refresh: (input) => read({ ...input, forceRefresh: true }),
    async getModel(idOrSlug, input) {
      const result = await read(input);
      return result.status !== 'unavailable'
        ? findOpenRouterModel(result.snapshot, idOrSlug)
        : undefined;
    },
    async listModels(filter, input) {
      validateOpenRouterModelFilter(filter);
      const result = await read(input);
      return result.status !== 'unavailable'
        ? listOpenRouterModels(result.snapshot, filter)
        : [];
    },
  };
}
