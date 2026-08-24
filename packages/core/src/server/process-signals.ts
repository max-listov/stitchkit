/**
 * Bind process signals to one managed server's shutdown.
 *
 * The framework still registers no listener on its own (→ ADR 0074): binding is
 * an explicit call the application makes, and `close()` takes it back. What this
 * removes is the state machine every application otherwise rewrites — and the
 * states hand-written versions miss: a signal arriving while asynchronous
 * preparation runs, a failing preparation, a rejected shutdown, a callback that
 * throws, and a third signal on a process whose default disposition the first
 * `process.on` already suppressed. → ADR 0076
 */

import {
  DEFAULT_PROCESS_SIGNALS,
  defaultSignalSource,
  guardSignalCallback,
  reportSignalError,
} from './process-signal-common';
import type { ShutdownOptions, ShutdownResult } from './shutdown';
import { ShutdownOptionsSchema } from './shutdown';

/**
 * Signal names this binding can listen for.
 *
 * Spelled out rather than reusing `NodeJS.Signals`: that namespace comes from
 * `@types/node`, which a browser-safe consumer of the published declarations
 * does not install — the consumer lane rejects an unresolvable name in the
 * shipped `.d.ts`. The set covers the termination signals a supervisor sends;
 * `SIGBREAK` is the Windows console equivalent of `SIGINT`, and Node on Windows
 * cannot listen for `SIGTERM` at all.
 */
export type ProcessSignalName =
  | 'SIGINT'
  | 'SIGTERM'
  | 'SIGHUP'
  | 'SIGQUIT'
  | 'SIGUSR2'
  | 'SIGBREAK';

/** The part of any managed handle this binding uses. */
export interface ShutdownTarget<TResult = ShutdownResult> {
  shutdown(options?: ShutdownOptions): Promise<TResult>;
}

/** Which phase failed, so one `onError` can tell them apart. */
export type ProcessSignalsErrorPhase = 'prepare' | 'shutdown' | 'complete';

/**
 * Where signals come from. `process` by default; a test passes its own so the
 * machine can be exercised without touching global state.
 */
export interface SignalSource {
  on(signal: ProcessSignalName, handler: () => void): void;
  off(signal: ProcessSignalName, handler: () => void): void;
  /**
   * Re-deliver the signal after this binding removed its own listeners, so the
   * process meets the signal's default disposition. Called only for an
   * escalation signal — one arriving when the shutdown is already forced or
   * finished, i.e. the operator asking for the process to die now.
   *
   * Returns `false` when the default could not be restored because something
   * else in the process still listens for that signal.
   */
  raiseDefault(signal: ProcessSignalName): boolean;
}

export interface ProcessSignalsOptions<TResult = ShutdownResult> {
  /**
   * Defaults to `['SIGINT', 'SIGTERM']`. Duplicates are ignored. Node on Windows
   * cannot listen for `SIGTERM`.
   */
  signals?: readonly ProcessSignalName[];
  /**
   * Budgets forwarded to `shutdown()`. `signal` is owned by this binding — it is
   * how a second signal forces the running chain — so it cannot be supplied
   * here. The type rejects it; at runtime the schema strips an extra key.
   */
  shutdown?: Omit<ShutdownOptions, 'signal'>;
  signalSource?: SignalSource;
  /**
   * Runs before `shutdown()`, on the first signal. Stop schedulers and workers
   * here. The server is still accepting requests during this phase — the
   * admission gate closes when `shutdown()` starts — so keep it short, or do the
   * work in `onComplete` instead.
   *
   * If it throws, the error is reported through `onError('prepare', …)` and the
   * shutdown **still runs**: a failed preparation must not leave the server
   * listening with nobody draining it.
   */
  onShutdown?: (signal: ProcessSignalName) => void | Promise<void>;
  /**
   * Runs after a successful shutdown. Close the database and set an exit code
   * here. If it throws, `promise` stays resolved — the transport really did shut
   * down — and the failure is reported through `onError('complete', …)`.
   */
  onComplete?: (result: TResult) => void | Promise<void>;
  /** Reports any phase failure, with the phase that produced it. */
  onError?: (phase: ProcessSignalsErrorPhase, error: unknown) => void;
  /** Runs for every counted signal after the first: one forces, later ones escalate. */
  onRepeatedSignal?: (signal: ProcessSignalName, phase: 'force' | 'escalate') => void;
  /**
   * Runs when an escalation signal could not restore the default disposition
   * because another listener in the process still handles it. The framework will
   * not call `process.exit` on its own; this is where an application decides
   * whether to.
   */
  onEscalationBlocked?: (signal: ProcessSignalName) => void;
}

export interface ProcessSignalsBinding<TResult = ShutdownResult> {
  /**
   * Resolves with the shutdown result, or with `undefined` when the binding was
   * closed before any signal arrived. Rejects only when the shutdown itself
   * failed. Already handled internally, so ignoring it never raises
   * `unhandledRejection`.
   */
  readonly promise: Promise<TResult | undefined>;
  /** Remove the listeners. Idempotent. */
  close(): void;
}

/**
 * One binding per handle while it can still start a chain. A second binding
 * would hand `shutdown()` a fresh `AbortSignal` that an existing chain ignores
 * (its options are parsed once), so its force path would be silently dead while
 * its `promise` resolved with the first chain's result.
 */
const bound = new WeakSet<ShutdownTarget<unknown>>();

/**
 * Bind `signals` to `handle.shutdown()`.
 *
 * - The first signal runs `onShutdown`, then one `shutdown()`.
 * - A later signal aborts that chain's signal, forcing it — the same chain,
 *   never a second one. Signals delivered in the same turn as the first (a
 *   supervisor sending `SIGINT` and `SIGTERM` together) are not that second
 *   press, so the declared grace period is not collapsed to zero.
 * - Any signal after the force, or one arriving while `onComplete` still runs,
 *   removes the listeners and re-delivers the signal so its default disposition
 *   applies. That works only while nothing else in the process listens for it;
 *   otherwise `onEscalationBlocked` fires.
 *
 * The framework never calls `process.exit` and never chooses an exit code — that
 * is supervisor policy (→ ADR 0074). Set `process.exitCode` in `onComplete` /
 * `onError`.
 */
export function bindProcessSignals<TResult = ShutdownResult>(
  handle: ShutdownTarget<TResult>,
  options: ProcessSignalsOptions<TResult> = {},
): ProcessSignalsBinding<TResult> {
  if (bound.has(handle)) {
    throw new Error(
      '[stitchkit] bindProcessSignals: this server is already bound; close the first binding before creating another',
    );
  }
  bound.add(handle);

  const signals = [...new Set(options.signals ?? DEFAULT_PROCESS_SIGNALS)];
  const source = options.signalSource ?? defaultSignalSource;
  // Parsed here so an invalid budget fails at binding time, not at the signal.
  const budgets = ShutdownOptionsSchema.omit({ signal: true }).parse(options.shutdown ?? {});

  const controller = new AbortController();
  const handlers: [ProcessSignalName, () => void][] = [];
  let started = false;
  /** The first signal's delivery turn — a repeat inside it is the same press. */
  let sameTurnAsStart = false;
  let settled = false;
  let closed = false;

  let resolveChain: (result: TResult | undefined) => void = () => undefined;
  let rejectChain: (error: unknown) => void = () => undefined;
  const promise = new Promise<TResult | undefined>((resolve, reject) => {
    resolveChain = resolve;
    rejectChain = reject;
  });
  // The caller may ignore `promise`; the rejection is still observed here.
  void promise.catch(() => undefined);

  const removeListeners = (): void => {
    if (closed) return;
    closed = true;
    for (const [signal, handler] of handlers) source.off(signal, handler);
    // The guard is released only while no chain exists. Releasing it mid-flight
    // would let a second binding attach to a `shutdown()` that ignores its
    // options — a dead force path reporting someone else's result.
    if (!started) bound.delete(handle);
  };

  const close = (): void => {
    const hadStarted = started;
    removeListeners();
    // Closing an idle binding means no signal will ever settle the chain.
    if (!hadStarted) resolveChain(undefined);
  };

  const run = async (signal: ProcessSignalName): Promise<void> => {
    try {
      await options.onShutdown?.(signal);
    } catch (error) {
      // Preparation failed — report it, but still shut the transport down.
      // Skipping it would leave the server accepting traffic with no owner.
      reportSignalError('prepare', error, options.onError);
    }

    let result: TResult;
    try {
      result = await handle.shutdown({ ...budgets, signal: controller.signal });
    } catch (error) {
      settled = true;
      rejectChain(error);
      reportSignalError('shutdown', error, options.onError);
      removeListeners();
      return;
    }

    settled = true;
    resolveChain(result);
    try {
      await options.onComplete?.(result);
    } catch (error) {
      // The transport did shut down; `promise` stays resolved and the callback's
      // own failure is reported separately.
      reportSignalError('complete', error, options.onError);
    } finally {
      removeListeners();
    }
  };

  const onSignal = (signal: ProcessSignalName): void => {
    if (!started) {
      started = true;
      sameTurnAsStart = true;
      // A supervisor may deliver two different signals in one turn; only a later
      // turn counts as a second press.
      queueMicrotask(() => {
        sameTurnAsStart = false;
      });
      // `run` never rejects on its own, but a callback reached through it might.
      void run(signal).catch((error) => reportSignalError('shutdown', error, options.onError));
      return;
    }

    if (sameTurnAsStart) return;

    // The controller exists before `onShutdown`, so a signal during preparation
    // still lands: `shutdown()` handles an already-aborted signal and forces.
    if (!settled && !controller.signal.aborted) {
      // State first, user code second — a throwing callback must not swallow the
      // force, and a re-entering one must find the machine consistent.
      controller.abort();
      guardSignalCallback(
        () => options.onRepeatedSignal?.(signal, 'force'),
        'shutdown',
        options.onError,
      );
      return;
    }

    removeListeners();
    guardSignalCallback(
      () => options.onRepeatedSignal?.(signal, 'escalate'),
      'shutdown',
      options.onError,
    );
    let restored = false;
    try {
      restored = source.raiseDefault(signal);
    } catch (error) {
      reportSignalError('shutdown', error, options.onError);
    }
    if (!restored) {
      guardSignalCallback(
        () => options.onEscalationBlocked?.(signal),
        'shutdown',
        options.onError,
      );
    }
  };

  for (const signal of signals) {
    const handler = () => onSignal(signal);
    handlers.push([signal, handler]);
    source.on(signal, handler);
  }

  return { promise, close };
}
