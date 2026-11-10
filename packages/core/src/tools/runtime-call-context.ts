// The leaf, not the barrel: `agent-runtime/durability` re-exports this type but
// also pulls the ledger and the scheduler, so an accidental loss of `import
// type` there would drag the runtime into the tools graph without a word.
import type { McpReportProgress } from '../contract/runtime-context';
import type { LocalStepDurability } from '../durability/contract';

/** What the agent runtime hands one tool call beside the SDK's own options. */
export interface RuntimeToolCall {
  /** The run's step ledger; absent when the runtime runs without durability. */
  durability?: LocalStepDurability;
  /** Publishes the call's progress into the run's event stream — the handler's `ctx.reportProgress`. */
  reportProgress: McpReportProgress;
}

type Factory = (callId: string, signal?: AbortSignal) => RuntimeToolCall;
const contexts = new WeakMap<object, Factory>();

/** Opaque SDK context; no credentials, functions or runtime objects enter provider messages. */
export function createRuntimeToolContext(factory: Factory): object {
  const context = {};
  contexts.set(context, factory);
  return context;
}

export function resolveRuntimeToolCall(
  context: unknown,
  callId: string,
  signal?: AbortSignal,
): RuntimeToolCall | undefined {
  if (typeof context !== 'object' || context === null) return undefined;
  return contexts.get(context)?.(callId, signal);
}
