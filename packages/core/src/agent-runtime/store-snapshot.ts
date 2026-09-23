import {
  type AgentMessage,
  type AgentRun,
  type AgentSnapshot,
  AgentSnapshotSchema,
} from './schemas';
import {
  type AgentRuntimeHead,
  type AgentStoredRun,
  AgentStoredRunSchema,
} from './store-driver-contract';

/**
 * Where a run sits in the conversation's own history — the position of the
 * earliest message it owns.
 *
 * Runs the history cannot place (every message of theirs compacted away) get
 * no position, and keep whatever order their timestamps give them.
 */
function historyPositions(messages: readonly AgentMessage[]): (run: AgentRun) => number {
  const positions = new Map<string, number>();
  messages.forEach((message, index) => {
    if (!positions.has(message.id)) positions.set(message.id, index);
  });
  return (run) => {
    let earliest = Number.MAX_SAFE_INTEGER;
    for (const id of [...run.inputMessageIds, run.assistantMessageId]) {
      const position = positions.get(id);
      if (position !== undefined && position < earliest) earliest = position;
    }
    return earliest;
  };
}

export function orderRuns(
  messages: readonly AgentMessage[],
  runs: readonly AgentRun[],
): AgentRun[] {
  const positionOf = historyPositions(messages);
  const fallback = (left: AgentRun, right: AgentRun): number =>
    left.createdAt.localeCompare(right.createdAt) ||
    positionOf(left) - positionOf(right) ||
    left.id.localeCompare(right.id);
  return [...runs].sort((left, right) => {
    if (
      left.executionSequence !== undefined &&
      right.executionSequence !== undefined &&
      left.executionSequence !== right.executionSequence
    ) {
      return left.executionSequence - right.executionSequence;
    }
    const leftStarted = left.executionSequence !== undefined || left.state !== 'queued';
    const rightStarted = right.executionSequence !== undefined || right.state !== 'queued';
    if (leftStarted !== rightStarted) return leftStarted ? -1 : 1;
    if (!leftStarted && !rightStarted) {
      const priority =
        Number(right.queuePriority !== undefined) - Number(left.queuePriority !== undefined);
      if (priority !== 0) return priority;
    }
    return fallback(left, right);
  });
}

/**
 * Put every run-owned message into durable causal order without moving
 * unowned history anchors such as summaries and system records.
 *
 * Admissions are durable before execution, so storage naturally appends a
 * queued successor's user message before the predecessor writes its assistant.
 * Replacing only the owned slots keeps storage codecs append-friendly while a
 * snapshot consistently reads as input(s) → answer, then successor input(s).
 */
export function orderRunMessages(
  messages: readonly AgentMessage[],
  runs: readonly AgentRun[],
): AgentMessage[] {
  const byId = new Map(messages.map((message) => [message.id, message]));
  const ownedIds = new Set(
    runs.flatMap((run) => [...run.inputMessageIds, run.assistantMessageId]),
  );
  const orderedOwned = runs.flatMap((run) =>
    [...run.inputMessageIds, run.assistantMessageId].flatMap((id) => {
      const message = byId.get(id);
      return message ? [message] : [];
    }),
  );
  let ownedIndex = 0;
  return messages.map((message) => {
    if (!ownedIds.has(message.id)) return message;
    const ordered = orderedOwned[ownedIndex];
    if (!ordered) throw new TypeError('Stored agent history lost a run-owned message');
    ownedIndex += 1;
    return ordered;
  });
}

export function snapshotOf(
  head: AgentRuntimeHead,
  messages: readonly AgentMessage[],
  records: readonly AgentStoredRun[],
): AgentSnapshot {
  validateSnapshot(head, messages, records);
  // Durable execution sequence first. Before a run starts, explicit urgent
  // priority precedes ordinary work; creation/history/id remain the stable
  // fallback inside either class and for legacy records.
  //
  // The middle key is not decoration. Two runs of one conversation are
  // routinely created inside the same millisecond — a successor coalescing
  // behind an active run always is — and an ISO timestamp cannot separate
  // them. Breaking that tie on a random UUID is a coin toss wearing the shape
  // of an order: it put a correct runtime behind a red release gate, because a
  // test read position 1 as "the successor" and half the time got the run it
  // was queued behind. History is the causal record the runtime already keeps
  // in order for the prompt, so it is what decides.
  const runs = orderRuns(
    messages,
    records.map((record) => record.run),
  );
  return AgentSnapshotSchema.parse({
    schemaVersion: 1,
    conversationId: head.conversationId,
    version: head.version,
    messages: orderRunMessages(messages, runs),
    runs,
  });
}

function validateSnapshot(
  head: AgentRuntimeHead,
  messages: readonly AgentMessage[],
  records: readonly AgentStoredRun[],
): void {
  const runIds = new Set<string>();
  const assistantIds = new Set<string>();
  const messageIds = new Set<string>();
  for (const record of records) {
    const run = record.run;
    if (
      run.conversationId !== head.conversationId ||
      runIds.has(run.id) ||
      assistantIds.has(run.assistantMessageId)
    ) {
      throw new TypeError('Stored agent runs contain inconsistent identities');
    }
    if (
      record.terminalAssistant &&
      (record.terminalAssistant.id !== run.assistantMessageId ||
        record.terminalAssistant.conversationId !== run.conversationId ||
        record.terminalAssistant.runId !== run.id ||
        record.terminalAssistant.role !== 'assistant' ||
        run.terminalReason === undefined)
    ) {
      throw new TypeError('Retained terminal assistant does not match its run');
    }
    runIds.add(run.id);
    assistantIds.add(run.assistantMessageId);
  }
  for (const message of messages) {
    if (message.conversationId !== head.conversationId || messageIds.has(message.id)) {
      throw new TypeError('Stored agent history contains inconsistent message identities');
    }
    messageIds.add(message.id);
    if (assistantIds.has(message.id) && message.runId === undefined) {
      throw new TypeError('Stored history occupies a reserved assistant identity');
    }
    if (message.runId !== undefined) {
      const run = records.find((candidate) => candidate.run.id === message.runId)?.run;
      if (!run || message.role !== 'assistant' || run.assistantMessageId !== message.id) {
        throw new TypeError(
          'Stored assistant history does not match its reserved run identity',
        );
      }
    }
  }
}

export function replaceRun(runs: readonly AgentRun[], next: AgentRun): AgentRun[] {
  return runs.map((run) => (run.id === next.id ? next : run));
}

export function replaceMessage(
  messages: readonly AgentMessage[],
  next: AgentMessage,
): AgentMessage[] {
  return messages.some((message) => message.id === next.id)
    ? messages.map((message) => (message.id === next.id ? next : message))
    : [...messages, next];
}

export function mergeRunRecords(
  ...groups: readonly (readonly AgentStoredRun[])[]
): AgentStoredRun[] {
  const records = new Map<string, AgentStoredRun>();
  for (const group of groups) {
    for (const rawRecord of group) {
      const record = AgentStoredRunSchema.parse(rawRecord);
      const previous = records.get(record.run.id);
      if (previous && previous.run.assistantMessageId !== record.run.assistantMessageId) {
        throw new TypeError('Stored agent run identity changed across normalized records');
      }
      records.set(record.run.id, record);
    }
  }
  return [...records.values()];
}

export function referencedRunIds(messages: readonly AgentMessage[]): string[] {
  return [...new Set(messages.flatMap((message) => (message.runId ? [message.runId] : [])))];
}
