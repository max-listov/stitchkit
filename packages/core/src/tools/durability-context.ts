// The leaf, not the barrel: `agent-runtime/durability` re-exports this type but
// also pulls the ledger and the scheduler, so an accidental loss of `import
// type` there would drag the runtime into the tools graph without a word.
import type { LocalStepDurability } from '../durability/contract';

type Factory = (callId: string, signal?: AbortSignal) => LocalStepDurability;
const contexts = new WeakMap<object, Factory>();

/** Opaque SDK context; no credentials, functions or runtime objects enter provider messages. */
export function createToolDurabilityContext(factory: Factory): object {
  const context = {};
  contexts.set(context, factory);
  return context;
}

export function resolveToolDurability(
  context: unknown,
  callId: string,
  signal?: AbortSignal,
): LocalStepDurability | undefined {
  if (typeof context !== 'object' || context === null) return undefined;
  return contexts.get(context)?.(callId, signal);
}
