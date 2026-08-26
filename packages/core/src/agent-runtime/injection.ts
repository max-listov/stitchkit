import type { AgentMessage } from './schemas';

/**
 * Which accepted-but-not-started inputs a run in flight may take on.
 *
 * Process-local on purpose, and that is the whole correction to the withdrawn
 * `inject` of 0.63.0. Absorption is a decision the executing process makes and
 * the terminal commit records; nothing durable happens in between. So this
 * registry may be lost — to a crash, a close, a restart — without leaving an
 * input unanswerable: every entry here is *also* an ordinary queued run in the
 * store, and losing the entry simply means that run answers itself.
 *
 * An entry is withdrawn the moment its own run starts executing. Without that,
 * a run could take on an input its own execution is about to answer, or a much
 * later run could absorb an input that was answered long ago.
 */
export interface AgentInjectableInput {
  runId: string;
  input: AgentMessage;
}

export interface AgentInjectionRegistry {
  offer(key: string, entry: AgentInjectableInput): void;
  /** Everything offered on this key except `excludeRunId`'s own entry. */
  take(key: string, excludeRunId: string): readonly AgentInjectableInput[];
  withdraw(key: string, runId: string): void;
  clear(): void;
}

export function createAgentInjectionRegistry(): AgentInjectionRegistry {
  const offered = new Map<string, AgentInjectableInput[]>();
  return {
    offer(key, entry) {
      const existing = offered.get(key);
      if (!existing) {
        offered.set(key, [entry]);
        return;
      }
      // Deduped by INPUT, not by run: `coalescePending` puts several inputs on
      // one queued successor, and a run that takes that successor on has to
      // take all of them or the absorption cannot be whole.
      if (existing.some((candidate) => candidate.input.id === entry.input.id)) return;
      existing.push(entry);
    },
    take(key, excludeRunId) {
      const existing = offered.get(key);
      if (!existing) return [];
      const taken = existing.filter((candidate) => candidate.runId !== excludeRunId);
      const kept = existing.filter((candidate) => candidate.runId === excludeRunId);
      if (kept.length === 0) offered.delete(key);
      else offered.set(key, kept);
      return taken;
    },
    withdraw(key, runId) {
      const existing = offered.get(key);
      if (!existing) return;
      const kept = existing.filter((candidate) => candidate.runId !== runId);
      if (kept.length === 0) offered.delete(key);
      else offered.set(key, kept);
    },
    clear() {
      offered.clear();
    },
  };
}
