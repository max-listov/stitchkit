import { abortReason, raceAbort } from '../../internal/abort-race';
import { loseEngineTurn } from '../engine-requests';
import type { JsonRpcPeer, JsonRpcValue } from '../json-rpc-peer';
import type { ExecutorProfileConfig } from '../profile';
import { emitStartupPhase, sessionAbort } from '../session-primitives';
import type { ExecutorStartupPhase } from '../vocabulary';
import { createCodexControlClient } from './control-client';
import { createCodexHandlers } from './handlers';
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
  closed: boolean;
  dead: Error | undefined;
  readonly abortThread: () => void;
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
  readonly openingNativeThreadIds: Set<string>;
  openingThreads: number;
  readonly isServerClosing: () => boolean;
  readonly getServerDead: () => Error | undefined;
  readonly ensureServerAlive: () => void;
}

function bestEffortUnsubscribe(state: SharedServerState, threadId: string): Promise<void> {
  if (state.isServerClosing() || state.getServerDead() !== undefined) {
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
  readonly threadAbort: ReturnType<typeof sessionAbort>;
}): CodexSession {
  const { state, slot, threadContext, activeModelProvider, threadAbort } = params;
  const { threadId } = slot;
  const ensureThreadAlive = () => {
    if (slot.closed) throw new Error('The Codex session is closed');
    if (slot.dead !== undefined) throw slot.dead;
    state.ensureServerAlive();
  };
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
    ensureAlive: ensureThreadAlive,
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

  const closeThread = async () => {
    if (slot.closed) return;
    slot.closed = true;
    const turn = slot.current;
    slot.current = undefined;
    slot.externalPending.clear();
    loseEngineTurn(turn, codexStopped, new Error('The Codex session closed'));
    state.threads.delete(threadId);
    try {
      await bestEffortUnsubscribe(state, threadId);
    } finally {
      threadAbort.abort();
      slot.releaseThreadSignal();
    }
  };

  threadAbort.signal.addEventListener(
    'abort',
    () => {
      if (slot.closed) return;
      slot.closed = true;
      const reason = abortReason(threadAbort.signal);
      slot.dead = slot.dead ?? (reason instanceof Error ? reason : new Error(String(reason)));
      const turn = slot.current;
      slot.current = undefined;
      slot.externalPending.clear();
      loseEngineTurn(turn, codexStopped, slot.dead);
      state.threads.delete(threadId);
      slot.releaseThreadSignal();
      void bestEffortUnsubscribe(state, threadId);
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
      ensureThreadAlive();
      answerCodexSessionRequest({
        turn: slot.current,
        externalPending: slot.externalPending,
        interactionId,
        reply,
      });
    },
    ...threadControlClient,
    ...bindCodexSessionThreadControls(threadControlClient, threadId),
    ...mutators,
    close: closeThread,
  };
}

export async function openSharedCodexThread(
  state: SharedServerState,
  threadInput: CodexSharedServerThreadInput,
): Promise<CodexSession> {
  state.ensureServerAlive();
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
  const threadAbort = sessionAbort(threadInput.signal);
  const onServerAbort = () => threadAbort.abort();
  state.serverSignal.addEventListener('abort', onServerAbort, { once: true });
  let signalReleased = false;
  const releaseThreadSignal = () => {
    if (signalReleased) return;
    signalReleased = true;
    state.serverSignal.removeEventListener('abort', onServerAbort);
    threadAbort.release();
  };

  state.openingThreads += 1;
  if (threadInput.nativeThreadId !== undefined) {
    state.openingNativeThreadIds.add(threadInput.nativeThreadId);
  }
  let registeredThreadId: string | undefined;
  const openControls = createCodexControlClient({
    peer: state.peer,
    imageOptions: state.config,
    signal: threadAbort.signal,
    ensureAlive: () => {
      threadAbort.signal.throwIfAborted();
      state.ensureServerAlive();
    },
    onBeforeInterruptTurn: state.onBeforeInterruptTurn,
  });
  try {
    threadAbort.signal.throwIfAborted();
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
      threadAbort.signal.throwIfAborted();
      state.ensureServerAlive();
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
    threadAbort.signal.throwIfAborted();
    state.ensureServerAlive();

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
      closed: false,
      dead: undefined,
      abortThread: () => threadAbort.abort(),
      releaseThreadSignal,
      handlers: createCodexHandlers({
        profileId: state.profile.profileId,
        limits: state.config.limits,
        externalPending,
        getTurn: () => slot.current,
        clearTurn: () => {
          slot.current = undefined;
        },
        ...(state.config.onNotification !== undefined && {
          onNotification: state.config.onNotification,
        }),
        ...(state.config.onServerRequest !== undefined && {
          onServerRequest: state.config.onServerRequest,
        }),
        ...(state.config.serverRequestDelivery !== undefined && {
          serverRequestDelivery: state.config.serverRequestDelivery,
        }),
      }),
    };
    state.threads.set(threadId, slot);
    registeredThreadId = threadId;

    if (state.config.verifyThread !== undefined) {
      emitStartupPhase(threadInput.onStartupPhase, 'verifying');
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
      threadAbort.signal.throwIfAborted();
    }
    state.ensureServerAlive();
    threadAbort.signal.throwIfAborted();
    if (slot.dead !== undefined) throw slot.dead;

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
