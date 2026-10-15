import { z } from 'zod';

const ObservationSchema = z.object({
  failure: z.enum(['deadline', 'observation']),
  groupId: z.number().int().positive(),
  observations: z.number().int().nonnegative(),
  lastStates: z.array(z.string().max(32)).max(16),
  elapsedMs: z.number().int().nonnegative(),
});
type Observation = z.infer<typeof ObservationSchema>;
const observations = new WeakMap<Error, Observation>();

/** Only this internal error carries process-state diagnostics safe to promote. */
export class GroupSettlementError extends Error {
  constructor(message: string, observation: Observation, cause: unknown = observation) {
    super(`${message}: ${JSON.stringify(observation)}`, { cause });
    // The original cause remains caller-readable. Keep a separate snapshot so a
    // caller cannot turn diagnostic fields into accessors before a later wrap.
    observations.set(this, { ...observation, lastStates: [...observation.lastStates] });
  }
}

/** Error data is an unknown caller boundary; diagnostic reads never invoke getters. */
function ownData(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

/** Bounded cause traversal; arbitrary caller messages never become cleanup diagnostics. */
export function groupSettlementDiagnostics(cause: unknown): Observation[] {
  const pending = [{ value: cause, depth: 0 }];
  const seen = new Set<unknown>();
  const found: Observation[] = [];
  for (let visited = 0; pending.length && visited < 32 && found.length < 4; visited++) {
    const entry = pending.pop();
    if (!entry || seen.has(entry.value)) continue;
    seen.add(entry.value);
    try {
      if (entry.value instanceof Error) {
        const observation = observations.get(entry.value);
        if (observation) found.push(observation);
      }
      if (!(entry.value instanceof Error) || entry.depth >= 8) continue;
      if (entry.value instanceof AggregateError) {
        const errors = ownData(entry.value, 'errors');
        if (Array.isArray(errors)) {
          for (let index = 0; index < 16; index++) {
            const value = ownData(errors, String(index));
            if (value !== undefined) pending.push({ value, depth: entry.depth + 1 });
          }
        }
      }
      const nested = ownData(entry.value, 'cause');
      if (nested !== undefined) pending.push({ value: nested, depth: entry.depth + 1 });
    } catch {
      // A caller can supply an Error proxy with throwing reflection traps. Optional
      // diagnostics must not replace COMMAND_CLEANUP or its original cause graph.
    }
  }
  return found;
}
