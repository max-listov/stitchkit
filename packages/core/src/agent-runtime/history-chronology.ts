import type { AgentMessagePart } from './schemas';

interface CallState {
  toolName: string;
  phase: 'called' | 'requested' | 'approved' | 'denied' | 'result';
}

/** Ephemeral call/approval validation state, never execution authority. */
export interface ToolChronology {
  calls: ReadonlyMap<string, CallState>;
  approvals: ReadonlyMap<string, string>;
  pending: number;
  resultsStarted: boolean;
}

export function createToolChronology(): ToolChronology {
  return { calls: new Map(), approvals: new Map(), pending: 0, resultsStarted: false };
}

/** Return a new state only if every part is valid; an omitted record changes nothing. */
export function advanceToolChronology(
  previous: ToolChronology,
  parts: readonly AgentMessagePart[],
): ToolChronology | undefined {
  const calls = new Map(previous.calls);
  const approvals = new Map(previous.approvals);
  let { pending, resultsStarted } = previous;
  for (const part of parts) {
    if (part.type === 'tool-call') {
      // Parallel calls may precede their approval requests. A dependent round
      // cannot begin while a returning round still owes any result.
      if (calls.has(part.callId) || (resultsStarted && pending > 0)) return undefined;
      if (pending === 0) resultsStarted = false;
      calls.set(part.callId, { toolName: part.toolName, phase: 'called' });
      pending += 1;
    } else if (part.type === 'tool-approval-request') {
      const call = calls.get(part.callId);
      if (call?.phase !== 'called' || approvals.has(part.approvalId)) return undefined;
      approvals.set(part.approvalId, part.callId);
      calls.set(part.callId, { ...call, phase: 'requested' });
    } else if (part.type === 'tool-approval-response') {
      const callId = approvals.get(part.approvalId);
      const call = callId === undefined ? undefined : calls.get(callId);
      if (callId === undefined || !call || call.phase !== 'requested') return undefined;
      calls.set(callId, { ...call, phase: part.approved ? 'approved' : 'denied' });
    } else if (part.type === 'tool-result') {
      const call = calls.get(part.callId);
      if (
        !call ||
        call.toolName !== part.toolName ||
        call.phase === 'result' ||
        call.phase === 'requested' ||
        (call.phase === 'denied' && part.outcome === 'success')
      )
        return undefined;
      calls.set(part.callId, { ...call, phase: 'result' });
      pending -= 1;
      resultsStarted = true;
    }
  }
  return { calls, approvals, pending, resultsStarted };
}

/** Only approvals may suspend a projected record with a result still outstanding. */
export function canProjectToolChronology(state: ToolChronology): boolean {
  return [...state.calls.values()].every(({ phase }) => phase !== 'called');
}
