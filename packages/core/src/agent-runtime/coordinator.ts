/**
 * What happens to a run in flight when new input arrives on the same key.
 *
 * `queue` finishes the run first. `interrupt` and `supersede` both end it, and
 * differ in one thing only: what becomes of what it produced. An interrupted
 * run's partial answer stays part of the conversation; a superseded run's does
 * not reach the model again.
 *
 * A fourth behaviour — hand the input to the loop between tool calls and let the
 * run continue — shipped as `inject` in 0.63.0 and was withdrawn in 0.65.0. It
 * committed the absorption durably before the answer existed, which left an
 * accepted input that no path could answer. The redesign is tracked separately.
 *
 * The runtime cannot decide that on its own, because the fact it turns on —
 * whether anyone saw the partial answer — belongs to the delivery surface. A
 * token stream shows it as it is produced; a surface that sends nothing until
 * the run is done never showed it at all. Hence a declared policy, and hence
 * `inputPolicy` accepting a function of the input: one application can hold
 * both surfaces.
 */
export type AgentInputPolicy = 'queue' | 'interrupt' | 'supersede';
export type AgentStopReason = 'user-interrupt' | 'supersede' | 'timeout' | 'shutdown';

export interface AgentCoordinatedRun<RESULT> {
  runId: string;
  execute(): Promise<RESULT>;
}

export interface AgentRunTicket<RESULT> {
  accepted: Promise<void>;
  result: Promise<RESULT>;
}

export interface AgentSessionCoordinator {
  submit<RESULT>(input: {
    key: string;
    policy: AgentInputPolicy;
    create(
      signal: AbortSignal,
    ): AgentCoordinatedRun<RESULT> | Promise<AgentCoordinatedRun<RESULT>>;
  }): AgentRunTicket<RESULT>;
  stop(key: string, reason?: AgentStopReason): boolean;
  close(options?: AgentSessionCloseOptions): Promise<AgentSessionCloseResult>;
  isRunning(key: string): boolean;
}

/**
 * The one rule for close budgets, so it can be applied before state changes.
 *
 * It used to live inside `close()` here and nowhere else, which meant the
 * runtime's own `close()` — which shuts admission first and only then delegates
 * — refused a bad budget *after* it had stopped admitting work: an exception
 * and a closed runtime, from a call that never legally started. Exported so the
 * check happens where nothing has been changed yet.
 */
export function assertCloseBudgets(options: AgentSessionCloseOptions): void {
  for (const [name, value] of Object.entries(options)) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new TypeError(`${name} must be a non-negative safe integer`);
    }
  }
}

export interface AgentSessionCloseOptions {
  /**
   * How long active runs may settle on their own before they are aborted.
   *
   * Same name and meaning as `ShutdownOptions.gracePeriodMs` on the server and
   * the application kernel; the default differs by surface and this one has
   * none — omitted means abort immediately, which is the behaviour `close()`
   * has always had.
   */
  gracePeriodMs?: number;
  /**
   * How long settlement may take *after* the abort, measured from the moment
   * the grace period ends. Omitted means wait for settlement without a bound.
   */
  forceTimeoutMs?: number;
}

/**
 * What `close()` actually achieved.
 *
 * The alternative was a `Promise<void>` and three claims in prose that cannot
 * all hold: "every combination is bounded", "omit `forceTimeoutMs` and it waits
 * for settlement", and "`close()` never returns while a run is still in
 * flight". Without a force budget the wait is unbounded; with one, returning
 * while a run is in flight is exactly what the budget is FOR. No implementation
 * satisfies all three, so the contract says what happens instead of promising
 * what cannot.
 *
 * A caller that only wants the old behaviour still writes `await close(…)` and
 * ignores the result; a caller that has to decide whether to exit reads it.
 */
export interface AgentSessionCloseResult {
  /** Every run that was in flight finished. `remaining` is then zero. */
  readonly settled: boolean;
  /** The force budget expired first. Mutually exclusive with `settled`. */
  readonly timedOut: boolean;
  /** Runs still in flight when `close()` returned. */
  readonly remaining: number;
}

interface PendingRun {
  start(): Promise<void>;
  reject(reason: unknown): void;
}

interface ActiveRun {
  controller: AbortController;
  settled: Promise<void>;
}

interface Lane {
  active?: ActiveRun;
  queue: PendingRun[];
}

export function createAgentSessionCoordinator(): AgentSessionCoordinator {
  const lanes = new Map<string, Lane>();
  let closed = false;

  const waitWithin = async (settled: Promise<void>, timeoutMs: number): Promise<boolean> => {
    if (timeoutMs === 0) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    const completed = settled.then(() => true);
    const result = await Promise.race([completed, timeout]);
    if (timer !== undefined) clearTimeout(timer);
    return result;
  };

  const laneFor = (key: string): Lane => {
    const existing = lanes.get(key);
    if (existing) return existing;
    const created: Lane = { queue: [] };
    lanes.set(key, created);
    return created;
  };

  const startNext = (key: string, lane: Lane): void => {
    if (lane.active) return;
    const next = lane.queue.shift();
    if (!next) {
      lanes.delete(key);
      return;
    }
    void next.start();
  };

  return {
    submit<RESULT>(input: {
      key: string;
      policy: AgentInputPolicy;
      create(
        signal: AbortSignal,
      ): AgentCoordinatedRun<RESULT> | Promise<AgentCoordinatedRun<RESULT>>;
    }): AgentRunTicket<RESULT> {
      const accepted = Promise.withResolvers<void>();
      const result = Promise.withResolvers<RESULT>();
      if (closed) {
        const error = new Error('Agent session coordinator is closed');
        accepted.reject(error);
        result.reject(error);
        return { accepted: accepted.promise, result: result.promise };
      }

      const lane = laneFor(input.key);
      const pending: PendingRun = {
        reject(reason) {
          accepted.reject(reason);
          result.reject(reason);
        },
        async start() {
          const controller = new AbortController();
          const settlement = Promise.withResolvers<void>();
          lane.active = { controller, settled: settlement.promise };
          try {
            const coordinated = await input.create(controller.signal);
            accepted.resolve();
            result.resolve(await coordinated.execute());
          } catch (error) {
            accepted.reject(error);
            result.reject(error);
          } finally {
            settlement.resolve();
            lane.active = undefined;
            startNext(input.key, lane);
          }
        },
      };

      // The abort reason is the only thing that survives into the terminal
      // record, so the two ending policies must not share one.
      if (input.policy === 'interrupt') lane.active?.controller.abort('user-interrupt');
      if (input.policy === 'supersede') lane.active?.controller.abort('supersede');
      lane.queue.push(pending);
      startNext(input.key, lane);
      return { accepted: accepted.promise, result: result.promise };
    },

    stop(key, reason = 'user-interrupt') {
      const lane = lanes.get(key);
      if (!lane?.active) return false;
      lane.active.controller.abort(reason);
      return true;
    },

    async close(options = {}) {
      assertCloseBudgets(options);
      closed = true;
      const error = new Error('Agent session coordinator is closed');
      for (const lane of lanes.values()) {
        for (const pending of lane.queue.splice(0)) pending.reject(error);
      }
      const active = [...lanes.values()]
        .map((lane) => lane.active)
        .filter((run) => run !== undefined);
      const settlements = active.map((run) => run.settled);
      // Counted rather than inferred: on a force timeout the caller needs to
      // know HOW MANY runs it is walking away from, and `Promise.all` losing
      // the race says only that at least one did not finish.
      const outstanding = new Set(settlements);
      for (const settled of settlements) {
        void settled.then(() => {
          outstanding.delete(settled);
        });
      }
      const drain = Promise.all(settlements).then(() => undefined);
      const finished = (): AgentSessionCloseResult => ({
        settled: outstanding.size === 0,
        timedOut: outstanding.size > 0,
        remaining: outstanding.size,
      });

      // Grace: let active runs finish on their own. Everything settled inside
      // the budget means there is nothing to force.
      if (
        options.gracePeriodMs !== undefined &&
        (await waitWithin(drain, options.gracePeriodMs))
      ) {
        return finished();
      }

      for (const run of active) run.controller.abort('shutdown');

      // Force: bound how long settlement may take after the abort. No budget
      // means wait for it — the only combination in which `close()` cannot
      // return with a run still in flight.
      if (options.forceTimeoutMs === undefined) {
        await drain;
        return finished();
      }
      await waitWithin(drain, options.forceTimeoutMs);
      return finished();
    },

    isRunning(key) {
      return lanes.get(key)?.active !== undefined;
    },
  };
}
