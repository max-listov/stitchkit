import { z } from 'zod';
import { AppError } from '../contract/errors';
import { ShutdownOptionsSchema } from '../server/shutdown';
import type { ManagedResource } from './resource';
import type {
  ApplicationResourceShutdown,
  ApplicationShutdownResult,
  ApplicationSnapshot,
} from './schemas';

/** The phase a managed resource failed in — the vocabulary of `failures`. */
export type ApplicationResourcePhase = ApplicationResourceShutdown['failures'][number];

/** One resource failure with the cause the phase label cannot carry. */
export interface ApplicationResourceFailure {
  readonly resourceId: string;
  readonly phase: ApplicationResourcePhase;
  /** The value the resource actually threw or rejected with. */
  readonly error: unknown;
}

/**
 * The budgets an application shutdown accepts.
 *
 * The same two names the server and the agent runtime use, and only those:
 * `retryAfterSeconds` is an HTTP response concern that belongs to the managed
 * server resource, and accepting it here typed and validated an option nothing
 * in the kernel ever read.
 */
export const ApplicationShutdownOptionsSchema = ShutdownOptionsSchema.pick({
  gracePeriodMs: true,
  forceTimeoutMs: true,
  signal: true,
});
export type ApplicationShutdownOptions = z.input<typeof ApplicationShutdownOptionsSchema>;

/**
 * The budget this application spends on stopping — and the one thing a failed
 * startup's rollback had no way to know.
 *
 * A rollback happens inside `start()`, so there is no call for a caller to pass
 * options to. The budget therefore has to be declared where the application is,
 * and once it is declared there it is also the sensible default for
 * `shutdown()` with no options: one number for "how long this application may
 * take to stop", not two that can disagree.
 *
 * `signal` is deliberately absent. A budget is a property of the application; a
 * signal belongs to the one call that carries it.
 */
export const ApplicationShutdownBudgetSchema = ShutdownOptionsSchema.pick({
  gracePeriodMs: true,
  forceTimeoutMs: true,
});
export type ApplicationShutdownBudget = z.input<typeof ApplicationShutdownBudgetSchema>;

export interface ApplicationConfig {
  readonly id: string;
  readonly resources?: readonly ManagedResource[];
  /**
   * How long stopping may take — for `shutdown()` called with no options, and
   * for the rollback of a failed `start()`, which has no other way to be told.
   */
  readonly shutdown?: ApplicationShutdownBudget;
  readonly onSnapshot?: (snapshot: ApplicationSnapshot) => void | Promise<void>;
  /**
   * Observe why a phase failed.
   *
   * `ApplicationResourceShutdown.failures` names the phase and nothing else, so
   * an operator reading it learns that `drain` failed and has no way to learn
   * why. The published response stays a verdict — this is the internal half of
   * the same rule: outward a generic answer, inward everything.
   *
   * Called for every failure of a resource's OWN code, in every phase:
   * `start`, `ready`, `completion`, `admission`, `drain`, `close` — including
   * the `close` that runs while rolling a failed startup back — and `force`.
   * It is NOT called for the kernel's own interruption of a startup that a
   * shutdown overtook: nothing failed there, and reporting it would bury the
   * one failure that did.
   *
   * A throwing observer cannot break the lifecycle it observes, and neither can
   * a REJECTING one: an `async` observer type-checks against a `void` return,
   * and its rejected promise is invisible to a synchronous `try/catch` around
   * the call. Returning a promise is therefore part of the signature, and the
   * kernel isolates it — it does not await it, so an observer cannot slow a
   * shutdown down either.
   */
  readonly onResourceFailure?: (failure: ApplicationResourceFailure) => void | Promise<void>;
}

export interface ApplicationOperationLease {
  readonly released: boolean;
  release(): void;
}

export interface ApplicationAdmission {
  acquire(): ApplicationOperationLease | null;
  run<T>(work: () => T | Promise<T>): Promise<T>;
}

export const ApplicationRestartInputSchema = z
  .object({
    resourceId: z.string().min(1),
    /**
     * Optional overrides of the application shutdown budget, for this restart.
     *
     * A restart takes its subtree down through the same three phases a shutdown
     * does, so it asks the same budget question and defaults to the same answer.
     * Naming one here is for the case a caller knows this subtree drains faster
     * than the process is allowed to.
     */
    gracePeriodMs: z.number().int().nonnegative().optional(),
    forceTimeoutMs: z.number().int().nonnegative().optional(),
  })
  .strict()
  .readonly();
export type ApplicationRestartInput = z.infer<typeof ApplicationRestartInputSchema>;

export const ApplicationRestartOutcomeSchema = z.enum(['restarted', 'failed', 'refused']);
export type ApplicationRestartOutcome = z.infer<typeof ApplicationRestartOutcomeSchema>;

export const ApplicationRestartResultSchema = z
  .object({
    /** The resource that was asked for. */
    resourceId: z.string(),
    /**
     * Everything that was actually taken down and brought back, in start order:
     * the resource named, and every resource that depends on it transitively.
     *
     * A dependant that kept running while the thing under it was replaced would
     * be holding a handle to a closed generation — which is why the subtree,
     * and not the resource, is the unit.
     */
    affected: z.array(z.string()).readonly(),
    outcome: ApplicationRestartOutcomeSchema,
    /** Present on `failed` and `refused` — never on success. */
    reason: z.string().optional(),
    durationMs: z.number().int().nonnegative(),
  })
  .strict()
  .readonly();
export type ApplicationRestartResult = z.infer<typeof ApplicationRestartResultSchema>;

export interface ApplicationHandle {
  readonly id: string;
  readonly admission: ApplicationAdmission;
  start(): Promise<ApplicationSnapshot>;
  getSnapshot(): ApplicationSnapshot;
  subscribe(listener: (snapshot: ApplicationSnapshot) => void): () => void;
  shutdown(options?: ApplicationShutdownOptions): Promise<ApplicationShutdownResult>;
  /**
   * Replace one resource and everything that depends on it, leaving the rest of
   * the graph running and the process epoch unchanged.
   *
   * Serialised against itself and refused during shutdown: two restarts of
   * overlapping subtrees, or a restart racing the way down, are the two ways to
   * end up with two live generations of one resource — which is the failure this
   * exists to make impossible, not merely unlikely.
   */
  restart(input: ApplicationRestartInput): Promise<ApplicationRestartResult>;
}

/**
 * An `AppError`, not an `Error` with a `code` field on it.
 *
 * The difference is the whole point of the class: `normalizeError` starts with
 * `AppError.is(err)`, and a plain `Error` — however carefully it names its own
 * code — falls through to the generic branch and reaches the caller as
 * `INTERNAL_SERVER_ERROR` / 500. So the declared 503 never left the process,
 * `createErrorHook({ unmappedCode })` never saw the code, and a registry entry
 * proved only that the code existed, never that it travelled.
 */
export class ApplicationAdmissionError extends AppError<'APPLICATION_NOT_ACCEPTING'> {
  constructor() {
    super('APPLICATION_NOT_ACCEPTING', 'Application is not accepting new operations', 503);
    this.name = 'ApplicationAdmissionError';
  }
}
