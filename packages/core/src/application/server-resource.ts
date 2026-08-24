import type { ManagedServerHandle, ShutdownResult } from '../server/shutdown';
import { defineManagedResource, type ManagedResource } from './resource';

export interface ManagedServerResourceConfig<TRuntime> {
  readonly id: string;
  readonly server: ManagedServerHandle<TRuntime> | (() => ManagedServerHandle<TRuntime>);
  readonly dependsOn?: readonly string[];
  readonly required?: boolean;
  readonly retryAfterSeconds?: number;
}

/** Adapt an existing managed server without duplicating its shutdown state machine. */
export function managedServerResource<TRuntime>(
  config: ManagedServerResourceConfig<TRuntime>,
): ManagedResource {
  let shutdownPromise: Promise<ShutdownResult> | undefined;
  const getServer = (): ManagedServerHandle<TRuntime> =>
    typeof config.server === 'function' ? config.server() : config.server;

  const ensureShutdown = (
    context: Parameters<ManagedResource['start']>[0],
    phase: 'graceful' | 'force' = 'graceful',
  ) => {
    if (shutdownPromise) return shutdownPromise;
    const now = context.now();
    const gracePeriodMs =
      phase === 'force' ? 0 : Math.max(0, (context.deadlineAt ?? now) - now);
    const forceTimeoutMs =
      phase === 'force'
        ? Math.max(0, (context.forceDeadlineAt ?? now) - now)
        : Math.max(
            0,
            (context.forceDeadlineAt ?? context.deadlineAt ?? now) -
              (context.deadlineAt ?? now),
          );
    shutdownPromise = getServer().shutdown({
      gracePeriodMs,
      forceTimeoutMs,
      retryAfterSeconds: config.retryAfterSeconds ?? 5,
      signal: context.signal,
    });
    void shutdownPromise.catch(() => undefined);
    return shutdownPromise;
  };

  return defineManagedResource({
    id: config.id,
    ...(config.dependsOn && { dependsOn: config.dependsOn }),
    ...(config.required !== undefined && { required: config.required }),
    start() {
      // The application owns when the already-created server becomes managed;
      // the server continues to own its HTTP/WebSocket lifecycle.
    },
    stopAdmission(context) {
      ensureShutdown(context);
    },
    async drain() {
      await shutdownPromise;
    },
    async close(context) {
      await ensureShutdown(context);
    },
    async force(context) {
      await ensureShutdown(context, 'force');
    },
  });
}
