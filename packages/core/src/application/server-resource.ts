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

  /**
   * A budget the server will accept.
   *
   * `context.now()` is `performance.now()` — a FRACTIONAL number of
   * milliseconds — and every budget here is a subtraction of two such readings,
   * so it is fractional too. `ShutdownOptionsSchema` declares both budgets as
   * integers and validates its input, so the server refused every call this
   * adapter made: not in an edge case, in all of them. A consumer who followed
   * the guide's advice not to re-implement the shutdown machine got `forced`
   * every time, and saw why only if they had wired `onResourceFailure`.
   *
   * A non-finite value is passed through on purpose. `Infinity` or `NaN` in a
   * deadline is a programming error, and the schema refuses it loudly; quietly
   * turning it into `0` would convert that into an immediate force with nothing
   * left to read afterwards.
   */
  const whole = (milliseconds: number, round: (value: number) => number): number =>
    Number.isFinite(milliseconds) ? Math.max(0, round(milliseconds)) : milliseconds;

  /** Rounded DOWN: a grace budget is time that remains, and `0` means "no grace". */
  const grace = (milliseconds: number): number => whole(milliseconds, Math.floor);

  /**
   * Rounded UP, because here `0` is not a small budget — it is an impossible
   * one. The server runs `withTimeout(forceStop(), forceTimeoutMs)`, so zero
   * gives the forced stop a single macrotask and then fails it with "forced
   * shutdown did not complete within 0ms". Flooring a sub-millisecond remainder
   * would manufacture exactly that; rounding it up cannot overrun anything.
   */
  const force = (milliseconds: number): number => whole(milliseconds, Math.ceil);

  const ensureShutdown = (
    context: Parameters<ManagedResource['start']>[0],
    phase: 'graceful' | 'force' = 'graceful',
  ) => {
    if (shutdownPromise) return shutdownPromise;
    const now = context.now();
    // An ABSENT deadline is not a spent one. `ManagedResourceContext` declares
    // both deadlines optional, so absence is a legal input every resource has to
    // answer for — and collapsing it into `now` answered "your budget is zero",
    // which is how a rollback came to hard-abort live requests. The honest
    // answer is to say nothing and let `ShutdownOptionsSchema` apply the
    // defaults it already carries: it is the source of truth for these numbers,
    // and re-deriving them here would be a second copy that can drift.
    const gracePeriodMs =
      phase === 'force'
        ? 0
        : context.deadlineAt === undefined
          ? undefined
          : grace(context.deadlineAt - now);
    const forceTimeoutMs =
      context.forceDeadlineAt === undefined
        ? undefined
        : phase === 'force'
          ? force(context.forceDeadlineAt - now)
          : force(context.forceDeadlineAt - (context.deadlineAt ?? now));
    shutdownPromise = getServer().shutdown({
      ...(gracePeriodMs !== undefined && { gracePeriodMs }),
      ...(forceTimeoutMs !== undefined && { forceTimeoutMs }),
      // The third integer field of the same schema, and it was left out of the
      // first repair. `ShutdownOptionsSchema` declares it `int()` too, the
      // config type is a bare `number`, and the upgrade guide actively tells a
      // consumer to move it here from `application.shutdown()` — where deriving
      // it from a duration (`timeoutMs / 1000`) lands straight on a fraction.
      // The failure was byte-for-byte the reported one, and worse: the server
      // is never closed, so the process hangs.
      retryAfterSeconds: grace(config.retryAfterSeconds ?? 5),
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
