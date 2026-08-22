export type AgentInputPolicy = 'queue' | 'interrupt';
export type AgentStopReason = 'user-interrupt' | 'timeout' | 'shutdown';

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
  close(options?: AgentSessionCloseOptions): Promise<void>;
  isRunning(key: string): boolean;
}

export interface AgentSessionCloseOptions {
  drainTimeoutMs?: number;
  forceTimeoutMs?: number;
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

      if (input.policy === 'interrupt') lane.active?.controller.abort('user-interrupt');
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
      for (const [name, value] of Object.entries(options)) {
        if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
          throw new TypeError(`${name} must be a non-negative safe integer`);
        }
      }
      closed = true;
      const error = new Error('Agent session coordinator is closed');
      for (const lane of lanes.values()) {
        for (const pending of lane.queue.splice(0)) pending.reject(error);
      }
      const active = [...lanes.values()]
        .map((lane) => lane.active)
        .filter((run) => run !== undefined);
      const settlements = active.map((run) => run.settled);
      const drain = Promise.all(settlements).then(() => undefined);
      if (options.drainTimeoutMs !== undefined) {
        const drained = await waitWithin(drain, options.drainTimeoutMs);
        if (drained) return;
      }
      for (const run of active) run.controller.abort('shutdown');
      if (options.drainTimeoutMs === undefined) return drain;
      if (options.forceTimeoutMs === undefined) return;
      await waitWithin(drain, options.forceTimeoutMs);
    },

    isRunning(key) {
      return lanes.get(key)?.active !== undefined;
    },
  };
}
