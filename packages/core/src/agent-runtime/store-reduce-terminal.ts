import {
  type AgentRun,
  AgentRunSchema,
  type AgentSnapshot,
  runStateForTerminalReason,
} from './schemas';
import type { CommitRunTerminal } from './store';
import { AgentStoredRunSchema } from './store-driver-contract';
import { applied, conflict, type ReducedMutation } from './store-reduce-shared';
import { replaceMessage, replaceRun } from './store-snapshot';
import { assistantStatus } from './terminal-status';

/** Finish a run with its final answer, absorbing any queued successors it answered. */
export function reduceTerminal(
  current: AgentSnapshot,
  run: AgentRun,
  input: CommitRunTerminal,
): ReducedMutation {
  // `absorbed` is never an operation's own reason. It is written onto the
  // *other* run of an absorbing commit, below, and a caller passing it here
  // would be terminalizing a run whose answer lives somewhere else.
  if (input.reason === 'absorbed') {
    throw new TypeError('A run is absorbed by another run, never terminalized as absorbed');
  }
  if (
    run.revision !== input.expectedRevision ||
    (run.state !== 'running' && run.state !== 'interrupt_requested') ||
    run.ownerId !== input.ownerId ||
    (input.fencingToken !== undefined && run.fencingToken !== input.fencingToken) ||
    input.assistant.runId !== run.id ||
    input.assistant.id !== run.assistantMessageId ||
    input.assistant.conversationId !== run.conversationId ||
    input.assistant.role !== 'assistant' ||
    input.assistant.status !== assistantStatus(input.reason)
  ) {
    return conflict(run.revision);
  }
  // Only a run that finished may claim to have answered somebody else's
  // input. An interrupted or failed run took the input into its prompt and
  // then stopped, so the successor stays queued and answers itself.
  if (input.absorb && runStateForTerminalReason(input.reason) !== 'completed') {
    throw new TypeError('Only a completing run may absorb a queued successor');
  }
  // Refused, not dropped — neither of these is a race, and dropping them
  // would hide a caller that has lost track of which run it is committing.
  const named = new Set((input.absorb ?? []).map((entry) => entry.runId));
  if (named.size !== (input.absorb ?? []).length || named.has(run.id)) {
    throw new TypeError(
      'An absorption names each successor once, and never the absorbing run',
    );
  }
  // Dropped rather than refused: a successor that is no longer queued has
  // been taken over by something else, and failing the commit over it would
  // lose the answer this run has already produced. The dropped successor runs
  // on its own, which is the behaviour it would have had anyway.
  const absorbable = (input.absorb ?? []).filter((entry) => {
    const candidate = current.runs.find((item) => item.id === entry.runId);
    return (
      candidate !== undefined &&
      candidate.id !== run.id &&
      candidate.state === 'queued' &&
      candidate.conversationId === run.conversationId &&
      candidate.inputMessageIds.length === entry.inputMessageIds.length &&
      candidate.inputMessageIds.every((id, index) => id === entry.inputMessageIds[index])
    );
  });
  const absorbedIds = new Set(absorbable.flatMap((entry) => entry.inputMessageIds));
  const next = AgentRunSchema.parse({
    ...run,
    state: runStateForTerminalReason(input.reason),
    terminalReason: input.reason,
    ...(input.policyName && { terminalPolicyName: input.policyName }),
    ...(input.usage && { usage: input.usage }),
    // The absorbed inputs are inputs this run answered, so they belong to its
    // record. Order is admission order, and the absorbed ones came last.
    ...(absorbedIds.size > 0 && {
      inputMessageIds: [
        ...run.inputMessageIds,
        ...[...absorbedIds].filter((id) => !run.inputMessageIds.includes(id)),
      ],
    }),
    revision: run.revision + 1,
    updatedAt: new Date().toISOString(),
  });
  // No assistant message for an absorbed run, deliberately. It produced
  // nothing; the answer is on `next`, and inventing an empty message here
  // would be a record saying this run answered when it did not. Its reserved
  // assistant identity simply stays unused.
  const absorbedRuns = absorbable.map((entry) => {
    const candidate = current.runs.find((item) => item.id === entry.runId);
    if (!candidate) throw new TypeError('Absorbed run disappeared inside the reducer');
    return AgentRunSchema.parse({
      ...candidate,
      state: runStateForTerminalReason('absorbed'),
      terminalReason: 'absorbed',
      absorbedIntoRunId: next.id,
      revision: candidate.revision + 1,
      updatedAt: new Date().toISOString(),
    });
  });
  const runs = absorbedRuns.reduce(
    (accumulated, absorbed) => replaceRun(accumulated, absorbed),
    replaceRun(current.runs, next),
  );
  return applied(
    current,
    {
      runs,
      messages: replaceMessage(current.messages, input.assistant),
    },
    {
      runRecords: [
        AgentStoredRunSchema.parse({
          schemaVersion: 1,
          run: next,
          terminalAssistant: input.assistant,
        }),
        ...absorbedRuns.map((absorbed) =>
          AgentStoredRunSchema.parse({ schemaVersion: 1, run: absorbed }),
        ),
      ],
      historyMutations: [{ type: 'upsert-assistant', message: input.assistant }],
    },
  );
}
