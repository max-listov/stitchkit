import {
  type AgentMessage,
  AgentMessagePartSchema,
  AgentMessageSchema,
  type AgentRun,
  type AgentSnapshot,
  type AgentTerminalReason,
  type AgentUsage,
} from './schemas';
import type { AgentRuntimeStore, AgentRunView, AgentStoreMutationResult } from './store';
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
  /**
   * Queued successors whose input this run took on, settled in the same
   * transaction as the terminal record (→ ADR 0113).
   *
   * Carried across a CAS retry: if the first attempt lost the race the
   * absorption has not happened either, and the retry must offer it again.
   */
  absorb?: { runId: string; inputMessageIds: string[] }[];
}

export interface AgentTerminalCommitResolution extends TerminalCommitCandidate {
  /**
   * The conversation's version at the moment this resolution was read.
   *
   * It used to be the whole `AgentSnapshot`, of which exactly one field was
   * ever read — and carrying it forced the conflict path to load every message
   * of the conversation to learn one number.
   */
  snapshotVersion: number;
  committedByCaller: boolean;
  /**
   * The queued successors this commit actually absorbed.
   *
   * Populated only on the applied path — the one where this executor wrote the
   * record and therefore knows. An absorption can be dropped by the reducer, so
   * this is what happened rather than what was asked for, and it is what the
   * delivery surface needs: a run that was admitted as `queued` and then
   * absorbed would otherwise never publish another state, and a UI following it
   * would wait forever.
   */
  absorbed?: readonly AgentRun[];
}

/** What `canonicalTerminal` needs: one run, its retained answer, one version. */
interface TerminalView {
  snapshotVersion: number;
  conversationId: string;
  run?: AgentRun;
  assistant?: AgentMessage;
}

function viewOfSnapshot(
  snapshot: AgentSnapshot,
  runId: string,
  retainedAssistant?: AgentMessage,
): TerminalView {
  const run = snapshot.runs.find((candidate) => candidate.id === runId);
  const assistant =
    snapshot.messages.find((message) => message.id === run?.assistantMessageId) ??
    retainedAssistant;
  return {
    snapshotVersion: snapshot.version,
    conversationId: snapshot.conversationId,
    ...(run && { run }),
    ...(assistant && { assistant }),
  };
}

function viewOfRun(view: AgentRunView, conversationId: string): TerminalView {
  return {
    snapshotVersion: view.snapshotVersion,
    conversationId,
    run: view.run,
    ...(view.assistant && { assistant: view.assistant }),
  };
}

function canonicalTerminal(view: TerminalView): AgentTerminalCommitResolution | undefined {
  const { run, assistant } = view;
  if (!run?.terminalReason) return undefined;
  if (
    view.conversationId !== run.conversationId ||
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
    snapshotVersion: view.snapshotVersion,
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
    //
    // `absorb` must not carry either, and for the same shape of reason: this
    // run is no longer completing, so it has not answered the input it took on.
    // Rebuilding the candidate field by field is what keeps that true — a
    // spread would quietly reinstate it.
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

/**
 * How many times a lost terminal CAS may be retried before the loop gives up.
 *
 * The loop used to be unbounded. Every legitimate outcome ends it in one or two
 * rounds — the other writer either terminalized the run, which returns, or took
 * ownership, which throws — so the only way to reach this number is a store that
 * conflicts forever while reporting a run this executor may still commit. That
 * is a livelock: a hot loop that never returns and never reports, on the path
 * that persists what a run produced. A bounded refusal is worse for nobody and
 * observable by everybody.
 */
const TERMINAL_COMMIT_ATTEMPTS = 32;

export async function commitAgentRunTerminal(input: {
  store: AgentRuntimeStore;
  runtimeEpoch: string;
  candidate: TerminalCommitCandidate;
  now: () => Date;
}): Promise<AgentTerminalCommitResolution> {
  let candidate = input.candidate;
  for (let attempt = 0; attempt < TERMINAL_COMMIT_ATTEMPTS; attempt += 1) {
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
      ...(candidate.absorb?.length && { absorb: candidate.absorb }),
    });
    if (committed.outcome === 'applied') {
      const terminal = canonicalTerminal(viewOfSnapshot(committed.snapshot, candidate.run.id));
      if (!terminal) throw new AgentRuntimeConflictError('terminal result projection');
      const absorbed = committed.snapshot.runs.filter(
        (run) => run.absorbedIntoRunId === candidate.run.id,
      );
      return {
        ...terminal,
        committedByCaller: true,
        ...(absorbed.length > 0 && { absorbed }),
      };
    }
    if (committed.outcome === 'duplicate') {
      const terminal = canonicalTerminal(
        viewOfSnapshot(committed.snapshot, candidate.run.id, committed.assistant),
      );
      if (!terminal) throw new AgentRuntimeConflictError('terminal result projection');
      return terminal;
    }
    if (committed.outcome !== 'conflict') {
      throw new AgentRuntimeConflictError('terminal commit');
    }
    // One run, not the conversation: this path runs on every lost CAS, and the
    // only things it reads are the run's state and the version to report.
    const latest = await input.store.loadRun({
      conversationId: candidate.run.conversationId,
      runId: candidate.run.id,
    });
    const terminal = latest
      ? canonicalTerminal(viewOfRun(latest, candidate.run.conversationId))
      : undefined;
    if (terminal) return terminal;
    const current = latest?.run;
    if (!current || !canRetryTerminal(current, candidate.run, input.runtimeEpoch)) {
      throw new AgentRuntimeConflictError('terminal commit');
    }
    candidate =
      current.state === 'interrupt_requested'
        ? interruptedCandidate(candidate, current, input.now)
        : { ...candidate, run: current };
  }
  throw new AgentRuntimeConflictError('terminal commit');
}
