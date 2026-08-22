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
  close(options?: { drainTimeoutMs?: number }): Promise<void>;
  isRunning(key: string): boolean;
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
      closed = true;
      const error = new Error('Agent session coordinator is closed');
      for (const lane of lanes.values()) {
        lane.active?.controller.abort('shutdown');
        for (const pending of lane.queue.splice(0)) pending.reject(error);
      }
      const settlements = [...lanes.values()]
        .map((lane) => lane.active?.settled)
        .filter((settled) => settled !== undefined);
      const drain = Promise.all(settlements).then(() => undefined);
      if (options.drainTimeoutMs === undefined) return drain;
      await Promise.race([
        drain,
        new Promise<void>((resolve) => setTimeout(resolve, options.drainTimeoutMs)),
      ]);
    },

    isRunning(key) {
      return lanes.get(key)?.active !== undefined;
    },
  };
}
