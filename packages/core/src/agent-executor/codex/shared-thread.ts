import { abortReason, linkAbortSignals, raceAbort } from '../../internal/abort-race';
import { loseEngineTurn } from '../engine-requests';
import type { JsonRpcPeer, JsonRpcValue } from '../json-rpc-peer';
import type { ExecutorProfileConfig } from '../profile';
import {
  emitStartupPhase,
  type SessionLiveness,
  sessionLiveness,
} from '../session-primitives';
import type { ExecutorStartupPhase } from '../vocabulary';
import { createCodexControlClient } from './control-client';
import { refuseStartingTurn } from './event-routing';
import { codexObserverOptions, createCodexHandlers } from './handlers';
import {
  CodexStartedThreadSchema,
  type CodexThreadContext,
  extractCodexThreadContext,
  parseCodexResponse,
} from './protocol';
import {
  answerCodexSessionRequest,
  type CodexTurnSlot,
  codexStopped,
  type PendingExternalCodexRequest,
  releaseExternalCodexRequests,
} from './request-answers';
import { bindCodexSessionThreadControls } from './session-bind';
import { createCodexSessionMutators } from './session-controls';
import type {
  CodexOpenForkOptions,
  CodexSession,
  CodexThreadPolicyOverrides,
} from './session-types';
import {
  type CodexSessionConfig,
  createCodexStartTurn,
  interruptAbandonedCodexTurn,
  openCodexThreadRpc,
  validateCodexOpenInput,
} from './thread-open';

const CLOSE_UNSUBSCRIBE_TIMEOUT_MS = 5_000;

/** Input to {@link CodexSharedServer.openThread} for opening one thread over a shared server. */
export interface CodexSharedServerThreadInput {
  readonly cwd: string;
  /** Resume this native thread via `thread/resume` (mutually exclusive with `forkFrom`). */
  readonly nativeThreadId?: string | undefined;
  /** Open the thread by forking an existing thread via `thread/fork` (mutually exclusive with `nativeThreadId`). */
  readonly forkFrom?: CodexOpenForkOptions | undefined;
  /** Optional observer invoked with startup phases (`verifying`) during thread open. */
  readonly onStartupPhase?: ((phase: ExecutorStartupPhase) => void) | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface SharedThreadSlot {
  readonly threadId: string;
  current: CodexTurnSlot | undefined;
  readonly externalPending: Map<string, PendingExternalCodexRequest>;
  readonly handlers: ReturnType<typeof createCodexHandlers>;
  /** Closing is the thread's own `close()`; a loss is the server's, the caller's or `thread/closed`. */
  readonly liveness: SessionLiveness;
  readonly abortThread: (reason?: unknown) => void;
  readonly releaseThreadSignal: () => void;
}

export interface SharedServerState {
  readonly config: CodexSessionConfig;
  readonly profile: ExecutorProfileConfig;
  readonly peer: JsonRpcPeer;
  readonly providerPid: number | undefined;
  readonly userAgent: string | undefined;
  readonly maxThreads: number;
  readonly onBeforeInterruptTurn: (threadId: string, turnId: string) => void;
  readonly serverSignal: AbortSignal;
  readonly threads: Map<string, SharedThreadSlot>;
  /** Threads closed locally whose unsubscribe has not settled: their late traffic is refused. */
  readonly closingThreadIds: Set<string>;
  readonly openingNativeThreadIds: Set<string>;
  openingThreads: number;
  readonly liveness: SessionLiveness;
}

function bestEffortUnsubscribe(state: SharedServerState, threadId: string): Promise<void> {
  if (state.liveness.closing || state.liveness.lost !== undefined) {
    return Promise.resolve();
  }
  return state.peer
    .request('thread/unsubscribe', { threadId }, { timeoutMs: CLOSE_UNSUBSCRIBE_TIMEOUT_MS })
    .then(
      () => undefined,
      () => undefined,
    );
}

function buildSharedThreadSession(params: {
  readonly state: SharedServerState;
  readonly slot: SharedThreadSlot;
  readonly threadContext: CodexThreadContext;
  readonly activeModelProvider: string | undefined;
  readonly threadAbort: {
    readonly signal: AbortSignal;
    abort(reason?: unknown): void;
    release(): void;
  };
}): CodexSession {
  const { state, slot, threadContext, activeModelProvider, threadAbort } = params;
  const { threadId, liveness } = slot;
  const ensureThreadAlive = () => liveness.ensureAlive();
  const threadControlClient = createCodexControlClient({
    peer: state.peer,
    imageOptions: state.config,
    signal: threadAbort.signal,
    ensureAlive: ensureThreadAlive,
    onBeforeInterruptTurn: state.onBeforeInterruptTurn,
  });
  const startTurn = createCodexStartTurn({
    config: state.config,
    peer: state.peer,
    threadId,
    activeModelProvider,
    signal: threadAbort.signal,
    liveness,
    getTurn: () => slot.current,
    setTurn: (turn) => {
      slot.current = turn;
    },
  });
  const mutators = createCodexSessionMutators({
    peer: state.peer,
    threadId,
    imageOptions: state.config,
    signal: threadAbort.signal,
    ensureAlive: ensureThreadAlive,
    getActiveTurn: () => slot.current,
  });

  /**
   * Detach the thread from a server that keeps running for its siblings: interrupt the turn the
   * server may still run, answer every request it holds as stopped, fail the local turn with
   * `reason`, and unsubscribe. Until the unsubscribe settles, the thread's late traffic is refused
   * instead of reaching the consumer as an external turn.
   */
  const retire = (reason: unknown): Promise<void> => {
    const turn = slot.current;
    slot.current = undefined;
    const interrupted = interruptAbandonedCodexTurn(state.peer, threadId, turn);
    refuseStartingTurn(turn);
    releaseExternalCodexRequests(slot.externalPending, true);
    loseEngineTurn(turn, codexStopped, reason);
    state.threads.delete(threadId);
    state.closingThreadIds.add(threadId);
    return interrupted
      .then(() => bestEffortUnsubscribe(state, threadId))
      .finally(() => state.closingThreadIds.delete(threadId));
  };

  const closeThread = async () => {
    if (liveness.closing) return;
    liveness.markClosing();
    if (liveness.lost !== undefined) {
      slot.releaseThreadSignal();
      return;
    }
    const retired = retire(new Error('The Codex session closed'));
    threadAbort.abort();
    try {
      await retired;
    } finally {
      slot.releaseThreadSignal();
    }
  };

  threadAbort.signal.addEventListener(
    'abort',
    () => {
      if (liveness.closing || liveness.lost !== undefined) return;
      const reason = abortReason(threadAbort.signal);
      liveness.markLost(reason);
      slot.releaseThreadSignal();
      void retire(reason);
    },
    { once: true },
  );

  return {
    nativeThreadId: threadId,
    providerPid: state.providerPid,
    userAgent: state.userAgent,
    threadContext,
    startTurn,
    async respond(interactionId, reply) {
      answerCodexSessionRequest({
        liveness,
        turn: slot.current,
        externalPending: slot.externalPending,
        interactionId,
        reply,
      });
    },
    ...threadControlClient,
    ...bindCodexSessionThreadControls(
      threadControlClient,
      threadId,
      (id) => state.threads.has(id) || state.closingThreadIds.has(id),
    ),
    ...mutators,
    close: closeThread,
  };
}

export async function openSharedCodexThread(
  state: SharedServerState,
  threadInput: CodexSharedServerThreadInput,
): Promise<CodexSession> {
  state.liveness.ensureAlive();
  validateCodexOpenInput({ ...threadInput, profile: state.profile });
  if (
    threadInput.nativeThreadId !== undefined &&
    (state.threads.has(threadInput.nativeThreadId) ||
      state.openingNativeThreadIds.has(threadInput.nativeThreadId))
  ) {
    throw new Error(
      `[stitchkit] CodexSharedServer.openThread: thread ${threadInput.nativeThreadId} is already open on this shared server`,
    );
  }
  if (state.threads.size + state.openingThreads >= state.maxThreads) {
    throw new RangeError(
      `[stitchkit] CodexSharedServer.openThread: active thread limit (${state.maxThreads}) reached`,
    );
  }
  const ownThreadAbort = new AbortController();
  const threadLink = linkAbortSignals(
    threadInput.signal,
    state.serverSignal,
    ownThreadAbort.signal,
  );
  let signalReleased = false;
  const releaseThreadSignal = () => {
    if (signalReleased) return;
    signalReleased = true;
    threadLink.release();
  };
  const threadAbort = {
    signal: threadLink.signal,
    abort: (reason?: unknown) => ownThreadAbort.abort(reason),
    release: releaseThreadSignal,
  };
  const liveness = sessionLiveness({
    closedMessage: 'The Codex session is closed',
    caller: threadInput.signal,
    linked: threadAbort.signal,
    within: state.liveness,
  });
  try {
    liveness.ensureAlive();
  } catch (error) {
    releaseThreadSignal();
    throw error;
  }

  state.openingThreads += 1;
  if (threadInput.nativeThreadId !== undefined) {
    state.openingNativeThreadIds.add(threadInput.nativeThreadId);
  }
  let registeredThreadId: string | undefined;
  const openControls = createCodexControlClient({
    peer: state.peer,
    imageOptions: state.config,
    signal: threadAbort.signal,
    ensureAlive: () => liveness.ensureAlive(),
    onBeforeInterruptTurn: state.onBeforeInterruptTurn,
  });
  try {
    let dynamicOverrides: CodexThreadPolicyOverrides | undefined;
    if (state.config.prepareThread !== undefined) {
      dynamicOverrides = await raceAbort(
        Promise.resolve(
          state.config.prepareThread({
            controls: openControls,
            cwd: threadInput.cwd,
            ...(threadInput.nativeThreadId !== undefined && {
              nativeThreadId: threadInput.nativeThreadId,
            }),
            ...(threadInput.forkFrom !== undefined && { forkFrom: threadInput.forkFrom }),
          }),
        ),
        threadAbort.signal,
      );
      liveness.ensureAlive();
    }
    const disposeLateOpen = (reply: JsonRpcValue) => {
      const parsedLate = CodexStartedThreadSchema.safeParse(reply);
      if (parsedLate.success && !state.threads.has(parsedLate.data.thread.id)) {
        void bestEffortUnsubscribe(state, parsedLate.data.thread.id);
      }
    };
    const openedReply = await raceAbort(
      openCodexThreadRpc(state.peer, state.config, threadInput, dynamicOverrides),
      threadAbort.signal,
      disposeLateOpen,
    );
    liveness.ensureAlive();

    const openMethod =
      threadInput.forkFrom !== undefined
        ? 'thread/fork'
        : threadInput.nativeThreadId !== undefined
          ? 'thread/resume'
          : 'thread/start';
    const parsed = parseCodexResponse(openMethod, CodexStartedThreadSchema, openedReply);
    const threadId = parsed.thread.id;
    const threadContext: CodexThreadContext = extractCodexThreadContext(parsed);
    if (state.threads.has(threadId)) {
      throw new Error(
        `[stitchkit] CodexSharedServer.openThread: thread ${threadId} is already open on this shared server`,
      );
    }

    const externalPending = new Map<string, PendingExternalCodexRequest>();
    const slot: SharedThreadSlot = {
      threadId,
      current: undefined,
      externalPending,
      liveness,
      abortThread: (reason) => threadAbort.abort(reason),
      releaseThreadSignal,
      handlers: createCodexHandlers({
        sharedWithOtherClients: false,
        profileId: state.profile.profileId,
        limits: state.config.limits,
        externalPending,
        liveness,
        getTurn: () => slot.current,
        clearTurn: () => {
          slot.current = undefined;
        },
        ...codexObserverOptions(state.config),
      }),
    };
    state.threads.set(threadId, slot);
    registeredThreadId = threadId;

    if (state.config.verifyThread !== undefined) {
      emitStartupPhase(threadInput.onStartupPhase, 'verifying', state.config.onObserverError);
      await raceAbort(
        Promise.resolve(
          state.config.verifyThread({
            nativeThreadId: threadId,
            threadContext,
            controls: openControls,
          }),
        ),
        threadAbort.signal,
      );
    }
    liveness.ensureAlive();

    const activeModelProvider =
      threadContext.modelProvider ??
      dynamicOverrides?.modelProvider ??
      threadInput.forkFrom?.modelProvider ??
      state.config.modelProvider;
    return buildSharedThreadSession({
      state,
      slot,
      threadContext,
      activeModelProvider,
      threadAbort,
    });
  } catch (error) {
    if (registeredThreadId !== undefined) {
      const failedSlot = state.threads.get(registeredThreadId);
      if (failedSlot !== undefined) {
        failedSlot.liveness.markClosing();
        failedSlot.externalPending.clear();
      }
      state.threads.delete(registeredThreadId);
      await bestEffortUnsubscribe(state, registeredThreadId);
    }
    threadAbort.abort();
    releaseThreadSignal();
    throw error;
  } finally {
    state.openingThreads -= 1;
    if (threadInput.nativeThreadId !== undefined) {
      state.openingNativeThreadIds.delete(threadInput.nativeThreadId);
    }
  }
}
