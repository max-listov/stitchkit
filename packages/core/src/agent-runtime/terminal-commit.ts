import {
  type AgentMessage,
  AgentMessagePartSchema,
  AgentMessageSchema,
  type AgentRun,
  type AgentSnapshot,
  type AgentTerminalReason,
  type AgentUsage,
} from './schemas';
import type { AgentRuntimeStore, AgentStoreMutationResult } from './store';
import { assistantStatus } from './terminal-status';

export class AgentRuntimeConflictError extends Error {
  constructor(operation: string) {
    super(`Agent runtime store conflict during ${operation}`);
    this.name = 'AgentRuntimeConflictError';
  }
}

export function appliedSnapshot(result: AgentStoreMutationResult, operation: string) {
  if (result.outcome === 'applied' || result.outcome === 'duplicate') return result.snapshot;
  throw new AgentRuntimeConflictError(operation);
}

interface TerminalCommitCandidate {
  run: AgentRun;
  assistant: AgentMessage;
  reason: AgentTerminalReason;
  policyName?: string;
  /** What this run cost, persisted with the terminal record. */
  usage?: AgentUsage;
}

export interface AgentTerminalCommitResolution extends TerminalCommitCandidate {
  snapshot: AgentSnapshot;
  committedByCaller: boolean;
}

function canonicalTerminal(
  snapshot: AgentSnapshot,
  runId: string,
  retainedAssistant?: AgentMessage,
): AgentTerminalCommitResolution | undefined {
  const run = snapshot.runs.find((candidate) => candidate.id === runId);
  if (!run?.terminalReason) return undefined;
  const assistant =
    snapshot.messages.find((message) => message.id === run.assistantMessageId) ??
    retainedAssistant;
  if (
    snapshot.conversationId !== run.conversationId ||
    !assistant ||
    assistant.id !== run.assistantMessageId ||
    assistant.conversationId !== run.conversationId ||
    assistant.runId !== run.id ||
    assistant.role !== 'assistant' ||
    assistant.status !== assistantStatus(run.terminalReason)
  ) {
    throw new AgentRuntimeConflictError('terminal result projection');
  }
  return {
    snapshot,
    run,
    assistant,
    reason: run.terminalReason,
    committedByCaller: false,
    ...(run.terminalPolicyName && { policyName: run.terminalPolicyName }),
    ...(run.usage && { usage: run.usage }),
  };
}

/**
 * Re-form a candidate whose run acquired a durable interrupt request mid-commit.
 *
 * The request says **stop the run**. It does not say what becomes of what the
 * run produced — and when the executor already decided that output is
 * `superseded`, that decision is the stronger one and survives. Forcing
 * `interrupted` here used to undo it: a stop button arriving between the
 * executor's last read and its terminal CAS republished the abandoned fragment
 * into the next prompt, which is the whole defect this path exists to prevent.
 */
function interruptedCandidate(
  candidate: TerminalCommitCandidate,
  run: AgentRun,
  now: () => Date,
): TerminalCommitCandidate {
  const reason: AgentTerminalReason =
    candidate.reason === 'superseded' ? 'superseded' : 'interrupted';
  const hasInterruptControl = candidate.assistant.parts.some(
    (part) => part.type === 'control' && part.reason === 'run-interrupted',
  );
  const parts = hasInterruptControl
    ? candidate.assistant.parts
    : [
        ...candidate.assistant.parts,
        AgentMessagePartSchema.parse({ type: 'control', reason: 'run-interrupted' }),
      ];
  return {
    // `usage` carries: the money was spent whatever the run ended up called.
    // `policyName` must NOT — it names the policy that stopped the run, and the
    // reason just changed out from under it. Spreading the whole candidate
    // carried both, and a run that ended `interrupted` then durably named a
    // stop policy that had not stopped it.
    ...(candidate.usage && { usage: candidate.usage }),
    run,
    assistant: AgentMessageSchema.parse({
      ...candidate.assistant,
      status: assistantStatus(reason),
      parts,
      updatedAt: now().toISOString(),
    }),
    reason,
  };
}

function canRetryTerminal(
  current: AgentRun,
  previous: AgentRun,
  runtimeEpoch: string,
): boolean {
  return (
    (current.state === 'running' || current.state === 'interrupt_requested') &&
    current.ownerId === runtimeEpoch &&
    current.fencingToken === previous.fencingToken
  );
}

export async function commitAgentRunTerminal(input: {
  store: AgentRuntimeStore;
  runtimeEpoch: string;
  candidate: TerminalCommitCandidate;
  now: () => Date;
}): Promise<AgentTerminalCommitResolution> {
  let candidate = input.candidate;
  while (true) {
    const committed = await input.store.commitRunTerminal({
      conversationId: candidate.run.conversationId,
      runId: candidate.run.id,
      expectedRevision: candidate.run.revision,
      ownerId: input.runtimeEpoch,
      ...(candidate.run.fencingToken !== undefined && {
        fencingToken: candidate.run.fencingToken,
      }),
      assistant: candidate.assistant,
      reason: candidate.reason,
      ...(candidate.policyName && { policyName: candidate.policyName }),
      ...(candidate.usage && { usage: candidate.usage }),
    });
    if (committed.outcome === 'applied') {
      const terminal = canonicalTerminal(committed.snapshot, candidate.run.id);
      if (!terminal) throw new AgentRuntimeConflictError('terminal result projection');
      return { ...terminal, committedByCaller: true };
    }
    if (committed.outcome === 'duplicate') {
      const terminal = canonicalTerminal(
        committed.snapshot,
        candidate.run.id,
        committed.assistant,
      );
      if (!terminal) throw new AgentRuntimeConflictError('terminal result projection');
      return terminal;
    }
    if (committed.outcome !== 'conflict') {
      throw new AgentRuntimeConflictError('terminal commit');
    }
    const latest = await input.store.loadSnapshot(candidate.run.conversationId);
    const terminal = canonicalTerminal(latest, candidate.run.id);
    if (terminal) return terminal;
    const current = latest.runs.find((run) => run.id === candidate.run.id);
    if (!current || !canRetryTerminal(current, candidate.run, input.runtimeEpoch)) {
      throw new AgentRuntimeConflictError('terminal commit');
    }
    candidate =
      current.state === 'interrupt_requested'
        ? interruptedCandidate(candidate, current, input.now)
        : { ...candidate, run: current };
  }
}
