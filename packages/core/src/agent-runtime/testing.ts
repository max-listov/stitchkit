export interface AgentRaceBarrier {
  reached: Promise<void>;
  wait(): Promise<void>;
  release(): void;
}

export function createAgentRaceBarrier(timeoutMs = 5_000): AgentRaceBarrier {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError('Agent race barrier timeoutMs must be a positive safe integer');
  }
  const reached = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  let announced = false;
  return {
    reached: reached.promise,
    async wait() {
      if (!announced) {
        announced = true;
        reached.resolve();
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          released.promise,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () =>
                reject(new Error(`Agent race barrier exceeded ${timeoutMs}ms teardown bound`)),
              timeoutMs,
            );
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
    release: released.resolve,
  };
}

export interface AgentRaceTraceEntry {
  name: string;
  sequence: number;
}

export interface AgentRaceTrace {
  record(name: string): AgentRaceTraceEntry;
  entries(): readonly AgentRaceTraceEntry[];
  assertBefore(first: string, second: string): void;
  assertSequence(names: readonly string[]): void;
  count(name: string): number;
}

export function createAgentRaceTrace(): AgentRaceTrace {
  const recorded: AgentRaceTraceEntry[] = [];
  return {
    record(name) {
      const entry = { name, sequence: recorded.length };
      recorded.push(entry);
      return entry;
    },
    entries: () => recorded.map((entry) => ({ ...entry })),
    assertBefore(first, second) {
      const firstEntry = recorded.find((entry) => entry.name === first);
      const secondEntry = recorded.find((entry) => entry.name === second);
      if (!firstEntry || !secondEntry || firstEntry.sequence >= secondEntry.sequence) {
        throw new Error(`Expected ${first} before ${second}`);
      }
    },
    assertSequence(names) {
      const actual = recorded.map((entry) => entry.name);
      if (
        actual.length !== names.length ||
        actual.some((name, index) => name !== names[index])
      ) {
        throw new Error(
          `Expected trace ${names.join(' -> ')}, received ${actual.join(' -> ')}`,
        );
      }
    },
    count: (name) => recorded.filter((entry) => entry.name === name).length,
  };
}

export interface AgentRaceDriver {
  trace: AgentRaceTrace;
  barrier(name: string): AgentRaceBarrier;
  releaseAll(): void;
}

/** Named deterministic barriers with one bounded cleanup operation for every scenario. */
export function createAgentRaceDriver(timeoutMs = 5_000): AgentRaceDriver {
  const trace = createAgentRaceTrace();
  const barriers = new Map<string, AgentRaceBarrier>();
  return {
    trace,
    barrier(name) {
      const existing = barriers.get(name);
      if (existing) return existing;
      const created = createAgentRaceBarrier(timeoutMs);
      barriers.set(name, created);
      return created;
    },
    releaseAll() {
      for (const barrier of barriers.values()) barrier.release();
    },
  };
}
