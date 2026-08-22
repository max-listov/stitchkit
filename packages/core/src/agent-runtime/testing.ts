export interface AgentRaceBarrier {
  reached: Promise<void>;
  wait(): Promise<void>;
  release(): void;
}

export function createAgentRaceBarrier(): AgentRaceBarrier {
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
      await released.promise;
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
  };
}
