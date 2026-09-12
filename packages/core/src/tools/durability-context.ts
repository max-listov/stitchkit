import type { LocalStepDurability } from '../agent-runtime/durability';

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
