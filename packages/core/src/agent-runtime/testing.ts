import { assertTimerMs } from '../internal/deadline';
import type {
  AgentModelDriver,
  AgentModelRequest,
  AgentModelStream,
  AgentModelStreamPart,
} from './models-driver';

/** One scripted turn for `createScriptedModelDriver`: static parts, a throw, or a factory. */
export type ScriptedModelStep =
  | readonly AgentModelStreamPart[]
  | { readonly throw: unknown }
  | ((
      request: AgentModelRequest,
      signal: AbortSignal,
    ) => AgentModelStream | Promise<AgentModelStream>);

export interface ScriptedModelDriverOptions {
  readonly provider?: string;
  readonly modelId?: string;
  readonly steps: readonly ScriptedModelStep[];
  readonly onRequest?: (request: AgentModelRequest, stepIndex: number) => void | Promise<void>;
}

export interface ScriptedModelDriver extends AgentModelDriver {
  readonly requests: readonly AgentModelRequest[];
}

/**
 * Deterministic peer-free `AgentModelDriver` for tests: replays scripted stream parts,
 * records every `AgentModelRequest`, and supports per-step errors or custom async streams.
 * → ADR 0336.
 */
export function createScriptedModelDriver(
  options: ScriptedModelDriverOptions,
): ScriptedModelDriver {
  const requests: AgentModelRequest[] = [];
  let index = 0;
  return {
    provider: options.provider ?? 'scripted',
    modelId: options.modelId ?? 'scripted-model',
    requests,
    async stream(request, signal) {
      const stepIndex = index;
      index += 1;
      requests.push(request);
      await options.onRequest?.(request, stepIndex);
      const step = options.steps[stepIndex];
      if (step === undefined) {
        throw new Error(`ScriptedModelDriver exhausted at step ${stepIndex}`);
      }
      if (typeof step === 'function') {
        return step(request, signal);
      }
      if ('throw' in step) {
        throw step.throw;
      }
      const list = step;
      return {
        parts: {
          async *[Symbol.asyncIterator]() {
            for (const part of list) {
              signal.throwIfAborted();
              yield part;
            }
          },
        },
      };
    },
  };
}

export interface AgentRaceBarrier {
  reached: Promise<void>;
  wait(): Promise<void>;
  release(): void;
}

export function createAgentRaceBarrier(timeoutMs = 5_000): AgentRaceBarrier {
  assertTimerMs('Agent race barrier timeoutMs', timeoutMs);
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
