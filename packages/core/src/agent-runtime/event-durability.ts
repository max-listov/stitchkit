import type { AgentRuntimeEvent } from './event-schema';

/** The events a snapshot accounts for: they carry an `eventId` and the `snapshotVersion` they follow. */
export type AgentDurableRuntimeEvent = Extract<
  AgentRuntimeEvent,
  {
    type:
      | 'admission'
      | 'assistant-checkpoint'
      | 'run-state'
      | 'run-operation'
      | 'tool-status'
      | 'terminal';
  }
>;

/** The one answer to "is this event durable": the browser cursor and the server cursor share it. */
export function isDurableAgentRuntimeEvent(
  event: AgentRuntimeEvent,
): event is AgentDurableRuntimeEvent {
  return (
    event.type === 'admission' ||
    event.type === 'assistant-checkpoint' ||
    event.type === 'run-state' ||
    event.type === 'run-operation' ||
    event.type === 'tool-status' ||
    event.type === 'terminal'
  );
}
