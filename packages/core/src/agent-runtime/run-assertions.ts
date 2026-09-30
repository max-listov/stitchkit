import { advanceToolChronology, createToolChronology } from './history-chronology';
import { type AgentRun, type AgentSnapshot, AgentSnapshotSchema } from './schemas';

/** Approval continuations carry their authorization as one of this run's exact input records. */
function continuedCalls(snapshot: AgentSnapshot, run: AgentRun) {
  let chronology = createToolChronology();
  const calls: Array<{ callId: string; toolName: string }> = [];
  for (const message of snapshot.messages) {
    if (message.role === 'user' && chronology.pending === 0)
      chronology = createToolChronology();
    if (
      message.conversationId !== run.conversationId ||
      !['assistant', 'tool'].includes(message.role)
    )
      continue;
    const next = advanceToolChronology(chronology, message.parts);
    if (!next) continue;
    if (message.role === 'tool' && run.inputMessageIds.includes(message.id)) {
      for (const part of message.parts) {
        if (part.type !== 'tool-approval-response' || !part.approved) continue;
        const callId = next.approvals.get(part.approvalId);
        const call = callId === undefined ? undefined : next.calls.get(callId);
        if (callId !== undefined && call?.phase === 'approved')
          calls.push({ callId, toolName: call.toolName });
      }
    }
    chronology = next;
  }
  return calls;
}

/** Assertions inspect durable evidence for exactly one run, independent of a test framework. */
export function inspectAgentRun(rawSnapshot: AgentSnapshot, runId: string) {
  const snapshot = AgentSnapshotSchema.parse(rawSnapshot);
  const run = snapshot.runs.find((candidate) => candidate.id === runId);
  if (!run) throw new Error(`Agent run ${runId} is absent from the snapshot`);
  const parts = snapshot.messages
    .filter(
      (message) => message.runId === runId && ['assistant', 'tool'].includes(message.role),
    )
    .flatMap((message) => message.parts);
  const results = parts.filter((part) => part.type === 'tool-result');
  const calls = [
    ...parts.filter((part) => part.type === 'tool-call'),
    ...continuedCalls(snapshot, run).filter((call) =>
      results.some(
        (result) => result.callId === call.callId && result.toolName === call.toolName,
      ),
    ),
  ];
  const fail = (message: string): never => {
    throw new Error(`Agent run ${runId}: ${message}`);
  };
  return {
    run,
    completed() {
      const pending = parts.some(
        (part) =>
          part.type === 'tool-approval-request' &&
          !parts.some(
            (response) =>
              response.type === 'tool-approval-response' &&
              response.approvalId === part.approvalId,
          ),
      );
      if (run.state !== 'completed' || run.terminalReason !== 'success' || pending)
        fail(
          `expected completed output; received ${run.state}/${run.terminalReason ?? 'pending'}${pending ? ' with pending approval' : ''}`,
        );
    },
    calledTool(name: string) {
      if (!calls.some((call) => call.toolName === name)) fail(`expected tool call ${name}`);
    },
    notCalledTool(name: string) {
      if (calls.some((call) => call.toolName === name)) fail(`unexpected tool call ${name}`);
    },
    toolSucceeded(name: string) {
      if (
        !calls.some(
          (call) =>
            call.toolName === name &&
            results.some(
              (result) =>
                result.callId === call.callId &&
                result.toolName === name &&
                result.outcome === 'success',
            ),
        )
      )
        fail(`expected successful result for tool ${name}`);
    },
  };
}
