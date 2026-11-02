import { storeRetryDelay } from './run-store-retry';
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

/**
 * A run is still active and nothing in this process is executing it.
 *
 * Either the store kept failing, or acquisition lost to a run ahead of it and
 * this one stayed queued. `run` is the record as this executor last read it, and
 * the store may be ahead of it: a lost reply can leave the record owned by
 * `ownerId`, this runtime. It does not change by itself: `recover()` skips a
 * `running` run with a live owner, and later turns of the conversation wait behind
 * it. Once the store answers, read the record: with no owner or with `ownerId` it is
 * this runtime's to pass to `abandon()`, and any other owner is executing it.
 */
export class AgentRunUnsettledError extends Error {
  readonly run: AgentRun;
  readonly ownerId: string;
  constructor(run: AgentRun, ownerId: string, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`Agent run ${run.id} is still ${run.state} with no executor: ${reason}`, { cause });
    this.name = 'AgentRunUnsettledError';
    this.run = run;
    this.ownerId = ownerId;
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

/** The terminal a snapshot records for one run, when it records one. */
export function terminalOfSnapshot(
  snapshot: AgentSnapshot,
  runId: string,
): AgentTerminalCommitResolution | undefined {
  return canonicalTerminal(viewOfSnapshot(snapshot, runId));
}

/** The terminal a one-run read records, when it records one. */
export function terminalOfRunView(
  view: AgentRunView,
  conversationId: string,
): AgentTerminalCommitResolution | undefined {
  return canonicalTerminal(viewOfRun(view, conversationId));
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

interface TerminalCommitInput {
  store: AgentRuntimeStore;
  runtimeEpoch: string;
  candidate: TerminalCommitCandidate;
  now: () => Date;
}

/** One round: the settled terminal, or the candidate to offer next. */
async function attemptTerminalCommit(
  input: TerminalCommitInput,
  candidate: TerminalCommitCandidate,
): Promise<
  | { settled: AgentTerminalCommitResolution }
  | { settled?: undefined; candidate: TerminalCommitCandidate }
> {
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
      settled: {
        ...terminal,
        committedByCaller: true,
        ...(absorbed.length > 0 && { absorbed }),
      },
    };
  }
  if (committed.outcome === 'duplicate') {
    const terminal = canonicalTerminal(
      viewOfSnapshot(committed.snapshot, candidate.run.id, committed.assistant),
    );
    if (!terminal) throw new AgentRuntimeConflictError('terminal result projection');
    return { settled: terminal };
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
  if (terminal) return { settled: terminal };
  const current = latest?.run;
  if (!current || !canRetryTerminal(current, candidate.run, input.runtimeEpoch)) {
    throw new AgentRuntimeConflictError('terminal commit');
  }
  return {
    candidate:
      current.state === 'interrupt_requested'
        ? interruptedCandidate(candidate, current, input.now)
        : { ...candidate, run: current },
  };
}

/** What a commit absorbed, for the caller that lost its reply. A read that fails names none. */
async function absorbedBy(
  store: AgentRuntimeStore,
  candidate: TerminalCommitCandidate,
): Promise<readonly AgentRun[]> {
  const views = await Promise.all(
    (candidate.absorb ?? []).map(({ runId }) =>
      store
        .loadRun({ conversationId: candidate.run.conversationId, runId })
        .catch(() => undefined),
    ),
  );
  return views.flatMap((view) =>
    view?.run.absorbedIntoRunId === candidate.run.id ? [view.run] : [],
  );
}

/**
 * Commit the terminal, through lost CAS rounds and through a store that fails.
 *
 * A thrown attempt is not known to have failed: a transaction whose COMMIT
 * reply was lost has applied, and the next round then finds the run already
 * terminal. That terminal has this executor's owner and fencing token, so it is
 * reported as committed by the caller, otherwise nobody delivers the answer,
 * and the successors it absorbed are read back so they are announced too.
 */
export async function commitAgentRunTerminal(
  input: TerminalCommitInput,
): Promise<AgentTerminalCommitResolution> {
  let candidate = input.candidate;
  let storeFailures = 0;
  for (let attempt = 0; attempt < TERMINAL_COMMIT_ATTEMPTS; attempt += 1) {
    try {
      const round = await attemptTerminalCommit(input, candidate);
      if (!round.settled) {
        candidate = round.candidate;
        continue;
      }
      const owned =
        storeFailures > 0 &&
        round.settled.run.ownerId === input.runtimeEpoch &&
        round.settled.run.fencingToken === candidate.run.fencingToken;
      if (!owned) return round.settled;
      const absorbed = await absorbedBy(input.store, candidate);
      return {
        ...round.settled,
        committedByCaller: true,
        ...(absorbed.length > 0 && { absorbed }),
      };
    } catch (error) {
      if (error instanceof AgentRuntimeConflictError) throw error;
      const delay = storeRetryDelay(storeFailures);
      if (delay === undefined) throw error;
      storeFailures += 1;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new AgentRuntimeConflictError('terminal commit');
}
