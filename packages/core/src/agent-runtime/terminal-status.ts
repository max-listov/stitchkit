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
export function assistantStatus(reason: AgentTerminalReason): AgentMessage['status'] {
  if (reason === 'success' || reason === 'policy_stop') return 'completed';
  if (reason === 'interrupted' || reason === 'cancelled' || reason === 'shutdown') {
    return 'interrupted';
  }
  return 'failed';
}
