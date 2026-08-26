import type { ManagedServerHandle, ShutdownOptions, ShutdownResult } from '../server/shutdown';
import {
  defineManagedResource,
  type ManagedResource,
  type ManagedResourceContext,
  type ManagedResourceDependency,
} from './resource';

export interface ManagedServerResourceConfig<TRuntime> {
  readonly id: string;
  /**
   * The server, or how to make one.
   *
   * A handle is adopted as it is. A thunk is called during `start`, which is
   * the only way to say "bind the port after the database is up" — and the only
   * reading of a thunk that is not a trap. It used to be called during
   * *shutdown*, so a graph that delegated creation here started clean, reported
   * `healthy`, and had nothing listening on the port; the failure surfaced as a
   * request that never arrived.
   */
  readonly server:
    | ManagedServerHandle<TRuntime>
    | (() => ManagedServerHandle<TRuntime> | Promise<ManagedServerHandle<TRuntime>>);
  readonly dependsOn?: readonly ManagedResourceDependency[];
  readonly required?: boolean;
  readonly retryAfterSeconds?: number;
}

/**
 * A managed resource that owns a managed server.
 *
 * Its `start` publishes the handle, so a resource that depends on this one
 * reads the running server with `context.use(...)` instead of a module-local.
 */
export interface ManagedServerResource<TRuntime> extends ManagedResource {
  start(
    context: ManagedResourceContext,
  ): Promise<{ readonly value: ManagedServerHandle<TRuntime> }>;
}

/** Own a managed server's lifecycle without duplicating its shutdown state machine. */
export function managedServerResource<TRuntime>(
  config: ManagedServerResourceConfig<TRuntime>,
): ManagedServerResource<TRuntime> {
  let shutdownPromise: Promise<ShutdownResult | undefined> | undefined;
  /** The handle `start` resolved. Absent until it runs — and if it never does. */
  let started: ManagedServerHandle<TRuntime> | undefined;
  /** Whether `start` ran at all, which is a different question from whether it worked. */
  let startAttempted = false;
  const resolveServer = ():
    | ManagedServerHandle<TRuntime>
    | Promise<ManagedServerHandle<TRuntime>> =>
    typeof config.server === 'function' ? config.server() : config.server;

  /**
   * Told apart by what the handle has, not by `instanceof Promise`: a thunk may
   * return any thenable, and a wrong answer here is a shutdown that never runs.
   */
  const isHandle = (
    value: ManagedServerHandle<TRuntime> | Promise<ManagedServerHandle<TRuntime>>,
  ): value is ManagedServerHandle<TRuntime> => 'shutdown' in value;

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
    // Three cases, and only the middle one is new. `started` is the handle in
    // every ordinary graph. If `start` ran and produced nothing — a thunk that
    // threw — there is no server, and calling the thunk again during the
    // rollback would raise its failure a second time, turning one honest
    // startup error into "startup and rollback failed". If `start` never ran at
    // all, the resource is being spread over someone else's `start` — the shape
    // the broken version forced on consumers — and the thunk is still the only
    // way to reach their server.
    const server = started ?? (startAttempted ? undefined : resolveServer());
    if (server === undefined) {
      shutdownPromise = Promise.resolve(undefined);
      return shutdownPromise;
    }
    const options: ShutdownOptions = {
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
    };
    // Synchronous when the server is already in hand, which is every case but a
    // pending async thunk. `stopAdmission` closes the admission gate by calling
    // this, so deferring it by a microtask would let requests in after the
    // application decided to stop accepting them.
    shutdownPromise = isHandle(server)
      ? server.shutdown(options)
      : server.then((handle) => handle.shutdown(options));
    void shutdownPromise.catch(() => undefined);
    return shutdownPromise;
  };

  return defineManagedResource({
    id: config.id,
    ...(config.dependsOn && { dependsOn: config.dependsOn }),
    ...(config.required !== undefined && { required: config.required }),
    async start() {
      // The application owns when the server exists; the server keeps owning its
      // own HTTP/WebSocket lifecycle once it does.
      startAttempted = true;
      started = await resolveServer();
      return { value: started };
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
