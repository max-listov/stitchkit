import type { AgentMessage, AgentTerminalReason } from './schemas';
/**
 * The terminal reason a run ended with → the status its assistant message takes.
 *
 * One home, because two of the three readers CHECK what the third WRITES: the
 * run executor sets the status from here, and both the terminal commit and the
 * store driver refuse a mutation whose status disagrees. As three copies, a new
 * terminal reason added to one of them made the invariant agree with a wrong
 * value — the check and the thing checked moving together, which is the one
 * shape an invariant must not have.
 */
/**
 * Whether an assistant record of this status may still reach the model.
 *
 * The same home as `assistantStatus`, and for the same reason. Three separate
 * walkers ask this question — the history projection, compaction, and the token
 * budget — and each used to answer it with its own inline list. Two of those
 * lists were blacklists, so adding `superseded` to the enum left both saying
 * yes: compaction summarised a discarded fragment back into the conversation
 * and deleted its record, and the budget protected it from eviction while never
 * sending it. A list that must be edited in three places when the enum grows is
 * the shape an invariant must not have.
 */
export function isSpeakableAssistantStatus(status: AgentMessage['status']): boolean {
  // A whitelist on purpose: a status added to the enum later is unspeakable
  // until someone says otherwise, which is the direction that fails loudly.
  // `committed` is in the list because the projection has always spoken it —
  // the core never writes it on an assistant, but the enum permits it, and
  // dropping it here would be a silent behaviour change outside this decision.
  return status === 'completed' || status === 'interrupted' || status === 'committed';
}

/** One policy shared by projection, budgeting and compaction for terminal evidence. */
export interface AgentHistoryEvidencePolicy {
  /** Default `omit`; opt in only when a host wants safe partial failure evidence. */
  failedAssistant?: 'omit' | 'assistant-marked';
}

export function isAssistantHistoryEvidence(
  status: AgentMessage['status'],
  policy: AgentHistoryEvidencePolicy | undefined,
): boolean {
  return (
    isSpeakableAssistantStatus(status) ||
    (status === 'failed' && policy?.failedAssistant === 'assistant-marked')
  );
}

/** Validate one complete user turn across every durable assistant/tool record. */
export function isCompleteAgentHistoryTurn(
  messages: readonly AgentMessage[],
  policy: AgentHistoryEvidencePolicy | undefined,
): boolean {
  if (messages[0]?.role !== 'user') return false;
  const calls = new Set<string>();
  const completed = new Set<string>();
  const approvals = new Map<string, { callId: string; answered: boolean }>();
  let assistantCount = 0;
  for (const message of messages) {
    if (message.role === 'assistant') {
      if (!isAssistantHistoryEvidence(message.status, policy)) return false;
      assistantCount += 1;
    }
    for (const part of message.parts) {
      if (part.type === 'tool-call') {
        if (calls.has(part.callId)) return false;
        calls.add(part.callId);
      } else if (part.type === 'tool-approval-request') {
        if (
          !calls.has(part.callId) ||
          completed.has(part.callId) ||
          approvals.has(part.approvalId)
        )
          return false;
        if ([...approvals.values()].some((approval) => approval.callId === part.callId))
          return false;
        approvals.set(part.approvalId, { callId: part.callId, answered: false });
      } else if (part.type === 'tool-approval-response') {
        const approval = approvals.get(part.approvalId);
        if (!approval || approval.answered) return false;
        approval.answered = true;
      } else if (part.type === 'tool-result') {
        if (!calls.has(part.callId) || completed.has(part.callId)) return false;
        const approval = [...approvals.values()].find((entry) => entry.callId === part.callId);
        if (approval && !approval.answered) return false;
        completed.add(part.callId);
      }
    }
  }
  return (
    assistantCount > 0 &&
    calls.size === completed.size &&
    [...approvals.values()].every((approval) => approval.answered)
  );
}

export function assistantStatus(reason: AgentTerminalReason): AgentMessage['status'] {
  if (reason === 'success' || reason === 'policy_stop' || reason === 'provider_stop') {
    return 'completed';
  }
  // Its own status, not a shade of `interrupted`. The two differ in exactly one
  // way — whether anything this run produced may still be shown to the model —
  // and that is the question the projection asks. Folding them together here
  // would put the answer back out of reach one layer down.
  if (reason === 'superseded') return 'superseded';
  // An absorbed run has no assistant message at all — its answer belongs to the
  // run that absorbed it — so nothing ever validates a message against this
  // arm. It exists because the enum is exhaustive here on purpose, and because
  // an absorbed run's record is `superseded`: whatever it might have said, the
  // model will not hear it from this run.
  if (reason === 'absorbed') return 'superseded';
  if (reason === 'interrupted' || reason === 'cancelled' || reason === 'shutdown') {
    return 'interrupted';
  }
  return 'failed';
}
