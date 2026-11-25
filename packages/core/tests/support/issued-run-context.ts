import { issueRunContext } from '../../src/agent-runtime/context-issue';
import type { AgentRuntimeRunContext } from '../../src/agent-runtime/runtime';

/**
 * A run context marked as a runtime's own, for a test of one tool factory
 * alone. The factories read only `run.conversationId`; the path through a
 * real runtime's `tools()` is proven in `agent-runtime-bound-tools.test.ts`.
 */
export function issuedRunContext(
  conversationId: string,
  signal: AbortSignal = new AbortController().signal,
): AgentRuntimeRunContext<unknown> {
  return issueRunContext({
    context: undefined,
    // Test-only: a factory reads nothing of the run but its conversation.
    run: { conversationId, id: `run-of-${conversationId}` } as never,
    signal,
    toolFenceLifecycle: { beforeHandle: () => undefined },
  });
}
