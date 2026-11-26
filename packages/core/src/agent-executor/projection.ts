import type { AgentMessagePart } from '../agent-parts/parts';
import type { ExecutorDelta } from './vocabulary';

/**
 * Fold a turn's deltas into the message parts the agent runtime stores.
 *
 * Mechanical on purpose: one item is one part, in the order items first
 * appeared; text and reasoning chunks append to their item; a tool call or
 * result replaces its item; an approval request becomes an approval-request
 * part. A `window` delta discards what was folded and starts again. Usage,
 * the context gauge, lifecycle `status` deltas, the end of the turn, errors and answered requests
 * carry no part — they are the turn's facts, not its content.
 */
export function projectExecutorDeltas(deltas: Iterable<ExecutorDelta>): AgentMessagePart[] {
  let items = new Map<string, AgentMessagePart>();
  for (const delta of deltas) {
    switch (delta.type) {
      case 'window':
        items = new Map();
        break;
      case 'text':
      case 'reasoning': {
        const previous = items.get(delta.itemId);
        const text = previous?.type === delta.type ? previous.text + delta.text : delta.text;
        items.set(
          delta.itemId,
          delta.type === 'text'
            ? { type: 'text', text }
            : {
                type: 'reasoning',
                text,
                ...(delta.provider !== undefined && { provider: delta.provider }),
              },
        );
        break;
      }
      case 'tool-call':
        items.set(delta.itemId, {
          type: 'tool-call',
          callId: delta.callId,
          toolName: delta.toolName,
          input: delta.input,
          ...(delta.provider !== undefined && { provider: delta.provider }),
        });
        break;
      case 'tool-result':
        items.set(delta.itemId, {
          type: 'tool-result',
          callId: delta.callId,
          toolName: delta.toolName,
          outcome: delta.outcome,
          ...(delta.output !== undefined && { output: delta.output }),
        });
        break;
      case 'request':
        if (delta.kind === 'approval' && delta.callId !== undefined) {
          items.set(delta.itemId, {
            type: 'tool-approval-request',
            approvalId: delta.interactionId,
            callId: delta.callId,
          });
        }
        break;
      case 'request-resolved':
      case 'usage':
      case 'context-usage':
      case 'status':
      case 'turn-end':
      case 'error':
        break;
    }
  }
  return [...items.values()];
}
