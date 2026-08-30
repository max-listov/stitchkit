import { z } from 'zod';
import type { FetchHandler } from './types';

export const ShutdownStateSchema = z.enum([
  'running',
  'draining-http',
  'closing-realtime',
  'stopping-runtime',
  'clean',
  'forced',
]);
export type ShutdownState = z.infer<typeof ShutdownStateSchema>;

export const ShutdownOptionsSchema = z.object({
  gracePeriodMs: z.number().int().nonnegative().default(30_000),
  realtimeCloseTimeoutMs: z.number().int().nonnegative().default(1_000),
  forceTimeoutMs: z.number().int().nonnegative().default(5_000),
  retryAfterSeconds: z.number().int().nonnegative().default(5),
  signal: z
    .custom<AbortSignal>(
      (value) =>
        typeof value === 'object' &&
        value !== null &&
        'aborted' in value &&
        'addEventListener' in value,
      'Expected an AbortSignal',
    )
    .optional(),
});
export type ShutdownOptions = z.input<typeof ShutdownOptionsSchema>;

export const ShutdownStatusSchema = z.object({
  state: ShutdownStateSchema,
  acceptedRequests: z.number().int().nonnegative(),
  completedRequests: z.number().int().nonnegative(),
  pendingRequests: z.number().int().nonnegative(),
  pendingWebSockets: z.number().int().nonnegative(),
});
export type ShutdownStatus = z.infer<typeof ShutdownStatusSchema>;

export const ShutdownResultSchema = z.object({
  outcome: z.enum(['clean', 'forced']),
  reason: z.enum(['deadline', 'signal']).optional(),
  acceptedRequests: z.number().int().nonnegative(),
  completedRequests: z.number().int().nonnegative(),
  pendingRequests: z.number().int().nonnegative(),
  pendingWebSockets: z.number().int().nonnegative(),
  pendingRequestsAtForce: z.number().int().nonnegative(),
  pendingWebSocketsAtForce: z.number().int().nonnegative(),
  abortedRequests: z.number().int().nonnegative(),
  forcedWebSockets: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative(),
});
export type ShutdownResult = z.infer<typeof ShutdownResultSchema>;

/** Shared lifecycle shape; only the explicit runtime escape hatch varies. */
export interface ManagedServerHandle<TRuntime> {
  readonly url: string;
  readonly port: number;
  readonly runtime: TRuntime;
  readonly status: ShutdownStatus;
  shutdown(options?: ShutdownOptions): Promise<ShutdownResult>;
}

export interface ShutdownAdapter {
  beginShutdown(retryAfterSeconds: number): void;
  pendingRequests(): number;
  pendingWebSockets(): number;
  closeRealtime(): Promise<void>;
  terminateRealtime(): Promise<number>;
  stopGracefully(): Promise<void>;
  forceStop(): Promise<void>;
}

interface ServerLifecycle {
  wrapFetch<TServer>(handler: FetchHandler<TServer>): FetchHandler<TServer>;
  readonly status: ShutdownStatus;
  shutdown(options?: ShutdownOptions): Promise<ShutdownResult>;
}

function rejectedResponse(retryAfterSeconds: number): Response {
  return Response.json(
    { error: { code: 'SERVER_SHUTTING_DOWN', message: 'Server is shutting down' } },
    {
      status: 503,
      headers: {
        Connection: 'close',
        'Retry-After': String(retryAfterSeconds),
      },
    },
  );
}

function waitForZero(read: () => number, signal: AbortSignal): Promise<void> {
  if (read() === 0) return Promise.resolve();
  return new Promise((resolve) => {
    const check = () => {
      if (read() === 0 || signal.aborted) {
        clearInterval(timer);
        signal.removeEventListener('abort', check);
        resolve();
      }
    };
    const timer = setInterval(check, 5);
    signal.addEventListener('abort', check, { once: true });
  });
}

function untilAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener('abort', () => resolve(), { once: true }),
  );
}

function closeRealtimeWithin(
  adapter: ShutdownAdapter,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<'closed' | 'timeout' | 'aborted'> {
  if (signal.aborted) return Promise.resolve('aborted');
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (outcome: 'closed' | 'timeout' | 'aborted') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(outcome);
    };
    const onAbort = () => finish('aborted');
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    signal.addEventListener('abort', onAbort, { once: true });
    adapter.closeRealtime().then(
      () => finish('closed'),
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function createServerLifecycle(getAdapter: () => ShutdownAdapter): ServerLifecycle {
  let state: ShutdownState = 'running';
  let acceptedRequests = 0;
  let completedRequests = 0;
  let pendingApplicationRequests = 0;
  let retryAfterSeconds = 5;
  let shutdownPromise: Promise<ShutdownResult> | undefined;

  const status = (): ShutdownStatus => {
    const adapter = getAdapter();
    return ShutdownStatusSchema.parse({
      state,
      acceptedRequests,
      completedRequests,
      pendingRequests: adapter.pendingRequests(),
      pendingWebSockets: adapter.pendingWebSockets(),
    });
  };

  const wrapFetch = <TServer>(handler: FetchHandler<TServer>): FetchHandler<TServer> => {
    return async (request, server) => {
      if (state !== 'running') return rejectedResponse(retryAfterSeconds);
      acceptedRequests += 1;
      pendingApplicationRequests += 1;
      try {
        return await handler(request, server);
      } finally {
        pendingApplicationRequests -= 1;
        completedRequests += 1;
      }
    };
  };

  const shutdown = (options?: ShutdownOptions): Promise<ShutdownResult> => {
    if (shutdownPromise) return shutdownPromise;
    const parsed = ShutdownOptionsSchema.parse(options ?? {});
    retryAfterSeconds = parsed.retryAfterSeconds;
    const startedAt = performance.now();
    const adapter = getAdapter();
    state = 'draining-http';
    adapter.beginShutdown(retryAfterSeconds);

    shutdownPromise = new Promise<ShutdownResult>((resolve, reject) => {
      const phaseAbort = new AbortController();
      let forcedReason: 'deadline' | 'signal' | 'error' | undefined;
      let phaseError: unknown;
      let forcedWebSockets = 0;
      const force = (reason: 'deadline' | 'signal' | 'error') => {
        if (forcedReason) return;
        forcedReason = reason;
        phaseAbort.abort();
      };
      const timer = setTimeout(() => force('deadline'), parsed.gracePeriodMs);
      const onExternalAbort = () => force('signal');
      parsed.signal?.addEventListener('abort', onExternalAbort, { once: true });
      if (parsed.signal?.aborted) force('signal');

      const cleanup = () => {
        clearTimeout(timer);
        parsed.signal?.removeEventListener('abort', onExternalAbort);
      };

      void (async () => {
        try {
          await waitForZero(() => pendingApplicationRequests, phaseAbort.signal);
          if (!forcedReason) {
            state = 'closing-realtime';
            const realtimeOutcome = await closeRealtimeWithin(
              adapter,
              parsed.realtimeCloseTimeoutMs,
              phaseAbort.signal,
            );
            if (
              !forcedReason &&
              realtimeOutcome === 'timeout' &&
              adapter.pendingWebSockets() > 0
            ) {
              forcedWebSockets += await Promise.race([
                adapter.terminateRealtime(),
                untilAbort(phaseAbort.signal).then(() => 0),
              ]);
            }
          }
          if (!forcedReason) {
            state = 'stopping-runtime';
            await Promise.race([adapter.stopGracefully(), untilAbort(phaseAbort.signal)]);
          }
        } catch (error) {
          if (!forcedReason) {
            phaseError = error;
            force('error');
          }
        }

        let pendingRequestsAtForce = 0;
        let pendingWebSocketsAtForce = 0;
        if (forcedReason) {
          state = 'stopping-runtime';
          pendingRequestsAtForce = adapter.pendingRequests();
          pendingWebSocketsAtForce = adapter.pendingWebSockets();
          forcedWebSockets += pendingWebSocketsAtForce;
          let forceError: unknown;
          let forceFailed = false;
          try {
            await withTimeout(
              adapter.forceStop(),
              parsed.forceTimeoutMs,
              `[stitchkit] forced shutdown did not complete within ${parsed.forceTimeoutMs}ms`,
            );
          } catch (error) {
            forceFailed = true;
            forceError = error;
          } finally {
            state = 'forced';
          }
          if (forcedReason === 'error') {
            if (forceFailed) {
              throw new AggregateError(
                [phaseError, forceError],
                '[stitchkit] graceful shutdown failed and forced cleanup also failed',
                { cause: phaseError },
              );
            }
            throw phaseError;
          }
          if (forceFailed) throw forceError;
        } else {
          state = 'clean';
        }

        cleanup();
        resolve(
          ShutdownResultSchema.parse({
            outcome: forcedReason ? 'forced' : 'clean',
            ...(forcedReason && { reason: forcedReason }),
            acceptedRequests,
            completedRequests,
            pendingRequests: adapter.pendingRequests(),
            pendingWebSockets: adapter.pendingWebSockets(),
            pendingRequestsAtForce,
            pendingWebSocketsAtForce,
            abortedRequests: pendingRequestsAtForce,
            forcedWebSockets,
            durationMs: performance.now() - startedAt,
          }),
        );
      })().catch((error) => {
        cleanup();
        reject(error);
      });
    });
    return shutdownPromise;
  };

  return {
    wrapFetch,
    get status() {
      return status();
    },
    shutdown,
  };
}
