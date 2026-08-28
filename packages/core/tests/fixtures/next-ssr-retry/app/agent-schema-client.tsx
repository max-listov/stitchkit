'use client';

import {
  AgentRunStateSchema,
  AgentRuntimeEventCursorSchema,
  AgentTerminalReasonSchema,
} from 'stitchkit/agent-runtime/browser';

export function AgentSchemaClientCompileProof() {
  const state = AgentRunStateSchema.parse('queued');
  const reason = AgentTerminalReasonSchema.parse('context_overflow');
  const cursor = AgentRuntimeEventCursorSchema.parse({ snapshotVersion: 1 });
  return <span data-agent-schema={`${state}:${reason}:${cursor.snapshotVersion}`} />;
}
