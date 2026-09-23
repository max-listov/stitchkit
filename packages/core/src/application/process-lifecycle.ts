import { z } from 'zod';
import {
  type DrainingFact,
  type LifecycleRun,
  type LifecycleState,
  normalizeLifecycleState,
  type ProcessLifecycleFact,
  type ReadyFact,
  type SameVersionOverlap,
  type ShutdownFact,
  type StartFact,
  transitionProcessDraining,
  transitionProcessReady,
  transitionProcessShutdown,
  transitionProcessStart,
} from './process-lifecycle-transitions';
import { defineManagedResource, type ManagedResource } from './resource';
import type { StateStore } from './state-store';

export interface ProcessLifecycleLedger {
  recordStart(input: { readonly version: string }): Promise<StartFact>;
  recordReady(): Promise<ReadyFact>;
  /** The run stopped admitting work; its `unavailableAt` is now. */
  recordDraining(): Promise<DrainingFact>;
  recordShutdown(input?: { readonly forced?: boolean }): Promise<ShutdownFact>;
  current(): Promise<LifecycleRun | null>;
  runs(): Promise<readonly LifecycleRun[]>;
  subscribe(listener: (fact: ProcessLifecycleFact) => void | Promise<void>): () => void;
}

export interface ProcessLifecycleLedgerConfig {
  readonly store: StateStore<LifecycleState>;
  readonly clock?: () => Date;
  readonly pid?: number;
  readonly retain?: number;
  readonly runId?: string | (() => string);
  readonly sameVersionOverlap?: SameVersionOverlap;
  readonly onSubscriberError?: (
    error: unknown,
    fact: ProcessLifecycleFact,
  ) => void | Promise<void>;
}

export function createProcessLifecycleLedger(
  config: ProcessLifecycleLedgerConfig,
): ProcessLifecycleLedger {
  const clock = config.clock ?? (() => new Date());
  const pid = z
    .number()
    .int()
    .positive()
    .parse(config.pid ?? process.pid);
  const retain = z
    .number()
    .int()
    .min(1)
    .max(1_000)
    .parse(config.retain ?? 20);
  const configuredRunId = config.runId;
  const nextRunId =
    typeof configuredRunId === 'function'
      ? configuredRunId
      : configuredRunId === undefined
        ? () => crypto.randomUUID()
        : () => configuredRunId;
  let runId = nextRunId();
  let started = false;
  const listeners = new Set<(fact: ProcessLifecycleFact) => void | Promise<void>>();

  const publish = (fact: ProcessLifecycleFact): void => {
    for (const listener of listeners) {
      Promise.resolve()
        .then(() => listener(fact))
        .catch((error) => config.onSubscriberError?.(error, fact));
    }
  };

  return {
    async recordStart({ version }) {
      if (started) runId = nextRunId();
      const fact = await config.store.update((state) => {
        const transition = transitionProcessStart(state, {
          runId,
          pid,
          version,
          now: clock().toISOString(),
          retain,
          sameVersionOverlap: config.sameVersionOverlap,
        });
        return { state: transition.state, result: transition.fact };
      });
      started = true;
      publish(fact);
      return fact;
    },
    async recordReady() {
      const fact = await config.store.update((state) => {
        const transition = transitionProcessReady(state, {
          runId,
          pid,
          now: clock().toISOString(),
          retain,
        });
        return { state: transition.state, result: transition.fact };
      });
      if (fact.recorded) publish(fact);
      return fact;
    },
    async recordDraining() {
      const fact = await config.store.update((state) => {
        const transition = transitionProcessDraining(state, {
          runId,
          pid,
          now: clock().toISOString(),
          retain,
        });
        return { state: transition.state, result: transition.fact };
      });
      if (fact.recorded) publish(fact);
      return fact;
    },
    async recordShutdown(input) {
      const fact = await config.store.update((state) => {
        const transition = transitionProcessShutdown(state, {
          runId,
          pid,
          now: clock().toISOString(),
          forced: input?.forced,
          retain,
        });
        return { state: transition.state, result: transition.fact };
      });
      if (fact.recorded) publish(fact);
      return fact;
    },
    async current() {
      const state = normalizeLifecycleState(await config.store.read(), retain);
      return state.runs.find((run) => run.runId === runId && run.pid === pid) ?? null;
    },
    async runs() {
      return normalizeLifecycleState(await config.store.read(), retain).runs;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export interface LifecycleLedgerResourceConfig {
  readonly id?: string;
  readonly version: string;
}

export interface LifecycleLedgerResource extends ManagedResource {
  start(): Promise<{ readonly value: ProcessLifecycleLedger }>;
}

export function lifecycleLedgerResource(
  ledger: ProcessLifecycleLedger,
  config: LifecycleLedgerResourceConfig,
): LifecycleLedgerResource {
  let stopped = false;
  let shutdown: Promise<ShutdownFact> | undefined;
  const stop = async (forced: boolean): Promise<void> => {
    if (stopped) return;
    if (!shutdown) shutdown = ledger.recordShutdown({ forced });
    try {
      await shutdown;
      stopped = true;
    } finally {
      if (!stopped) shutdown = undefined;
    }
  };
  return defineManagedResource({
    id: config.id ?? 'lifecycle',
    async start() {
      // A restart re-enters `start` on the same resource: the previous run's
      // settled shutdown must not answer for the new run's.
      stopped = false;
      shutdown = undefined;
      await ledger.recordStart({ version: config.version });
      return { value: ledger };
    },
    async activate() {
      await ledger.recordReady();
    },
    // Admission stopping is the moment the application stops answering: the
    // drain that follows, however long, is already unavailability.
    async stopAdmission() {
      await ledger.recordDraining();
    },
    async close() {
      await stop(false);
    },
    async force() {
      await stop(true);
    },
  });
}
