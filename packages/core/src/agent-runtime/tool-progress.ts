/**
 * The agent runtime's `ctx.reportProgress`: what a tool handler says about
 * itself while it runs becomes a transient `tool-progress` event of the run.
 *
 * The handler API is the one MCP already serves, so a tool written for an MCP
 * host reports to the agent's screen unchanged. Progress is for the person
 * watching: it never reaches the model, which receives only the tool's result,
 * and it is not part of the durable history.
 */
import type { ToolSet } from 'ai';
import type { McpProgressUpdate, McpReportProgress } from '../contract/runtime-context';
import { AGENT_TOOL_PROGRESS_MESSAGE_MAX } from './event-schema';
import type { RunExecution } from './run-execution-state';
import { transientHead } from './run-stream-parts';

/**
 * The shortest gap between two published reports of one call. A handler that
 * reports on every chunk would otherwise outpace the stream it rides on; the
 * call's terminal `tool-status` carries the final word either way.
 */
export const TOOL_PROGRESS_MIN_INTERVAL_MS = 250;

function finite(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) ? value : undefined;
}

/** One reporter per tool call, bound to the run that issued it. */
export function createToolProgressReporter<CONTEXT, TOOLS extends ToolSet>(
  execution: RunExecution<CONTEXT, TOOLS>,
  toolName: string,
  callId: string,
  signal?: AbortSignal,
): McpReportProgress {
  let lastPublishedAt: number | undefined;
  return async (update: McpProgressUpdate) => {
    // A report after the call settled or its attempt was abandoned describes
    // work nobody is waiting for; dropping it is the honest answer, not an
    // error the handler has to handle.
    if (signal?.aborted || execution.state.settledToolCalls.has(callId)) return;
    const now = execution.dependencies.now();
    if (
      lastPublishedAt !== undefined &&
      now.getTime() - lastPublishedAt < TOOL_PROGRESS_MIN_INTERVAL_MS
    ) {
      return;
    }
    lastPublishedAt = now.getTime();
    const message = update.message?.slice(0, AGENT_TOOL_PROGRESS_MESSAGE_MAX);
    const progress = finite(update.progress);
    const total = finite(update.total);
    await execution.dependencies.publish({
      type: 'tool-progress',
      ...transientHead(execution),
      callId,
      toolName,
      ...(message !== undefined && { message }),
      ...(progress !== undefined && { progress }),
      ...(total !== undefined && { total }),
      emittedAt: now.toISOString(),
    });
  };
}
