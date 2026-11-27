import { abortReason, raceAbort } from '../../internal/abort-race';
import { loseEngineTurn } from '../engine-requests';
import { engineProfile } from '../profile';
import {
  emitStartupPhase,
  invokeObserver,
  sessionAbort,
  sessionLiveness,
  stopConnection,
} from '../session-primitives';
import { codexTransportShared, connectCodex } from './connect';
import {
  type CodexControlConnectInput,
  type CodexControlConnection,
  createCodexControlClient,
} from './control-client';
import { codexThreadIdOf, discardStartingTurn } from './event-routing';
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
  releaseExternalCodexRequestsBeforeStop,
} from './request-answers';
import { bindCodexSessionThreadControls } from './session-bind';
import { createCodexSessionMutators } from './session-controls';
import type {
  CodexOpenInput,
  CodexSession,
  CodexThreadPolicyOverrides,
} from './session-types';
import {
  type CodexSessionConfig,
  createCodexStartTurn,
  interruptLocalCodexTurn,
  openCodexThreadRpc,
  validateCodexOpenInput,
} from './thread-open';

/**
 * The session's handlers, plus one fact they cannot see: the server unloaded the session's own
 * thread (`thread/closed`), after which nothing on it can run or be answered.
 */
function threadClosedAware(
  handlers: ReturnType<typeof createCodexHandlers>,
  ownThreadId: () => string | undefined,
  onOwnThreadClosed: (reason: Error) => void,
): ReturnType<typeof createCodexHandlers> {
  return {
    onNotification(method, params) {
      handlers.onNotification(method, params);
      const own = ownThreadId();
      if (method === 'thread/closed' && own !== undefined && codexThreadIdOf(params) === own)
        onOwnThreadClosed(new Error(`Codex closed thread ${own}`));
    },
    onRequest: handlers.onRequest,
  };
}

/**
 * One app-server connection holding one thread. Server requests during `startTurn()` become
 * `request` deltas answered by `respond` (and also reach `onServerRequest` when
 * `serverRequestDelivery` is `'all'`); external/TUI requests route through `onServerRequest`
 * when configured, and unknown methods are refused `-32601`.
 */
export async function openCodexSession(
  config: CodexSessionConfig,
  input: CodexOpenInput,
): Promise<CodexSession> {
  validateCodexOpenInput(input);
  const profile = engineProfile('codex', input.profile);
  const linked = sessionAbort(input.signal);
  const externalPending = new Map<string, PendingExternalCodexRequest>();
  let current: CodexTurnSlot | undefined;
  let activeThreadId: string | undefined;
  let opened = false;
  const liveness = sessionLiveness({
    closedMessage: 'The Codex session is closed',
    caller: input.signal,
    linked: linked.signal,
  });
  const ensureAlive = () => liveness.ensureAlive();
  let connected: Awaited<ReturnType<typeof connectCodex>>;
  try {
    connected = await connectCodex(
      config,
      profile,
      input.cwd,
      linked.signal,
      threadClosedAware(
        createCodexHandlers({
          sharedWithOtherClients: codexTransportShared(config),
          profileId: profile.profileId,
          limits: config.limits,
          externalPending,
          liveness,
          closingGracefully: () => liveness.closingGracefully,
          getTurn: () => current,
          clearTurn: () => {
            current = undefined;
          },
          ...codexObserverOptions(config),
        }),
        () => activeThreadId,
        (closed) => {
          if (liveness.closing || liveness.lost !== undefined) return;
          liveness.markLost(closed);
          const turn = current;
          current = undefined;
          discardStartingTurn(turn);
          loseEngineTurn(turn, codexStopped, closed);
        },
      ),
      (error) => {
        const { abortedByCaller } = liveness;
        const shouldNotify = opened && !liveness.closing && !abortedByCaller;
        if (!liveness.closing && !abortedByCaller) liveness.markLost(error);
        const turn = current;
        current = undefined;
        discardStartingTurn(turn);
        // Never send `cancel` for external TUI requests when our observer disconnects.
        externalPending.clear();
        loseEngineTurn(
          turn,
          codexStopped,
          abortedByCaller && input.signal !== undefined ? abortReason(input.signal) : error,
        );
        linked.abort();
        if (shouldNotify)
          invokeObserver(config.onObserverError, 'onDisconnect', () =>
            config.onDisconnect?.(error),
          );
      },
      input.onStartupPhase,
    );
  } catch (error) {
    linked.release();
    throw error;
  }
  const { peer, providerPid, userAgent } = connected;
  const answersWhileClosing = () =>
    liveness.closingGracefully && !codexTransportShared(config);
  const stop = async (primary?: { error: unknown }) => {
    liveness.markClosing();
    discardStartingTurn(current);
    await releaseExternalCodexRequestsBeforeStop([externalPending], answersWhileClosing());
    try {
      await stopConnection(connected, primary);
    } finally {
      linked.abort();
      linked.release();
    }
  };
  const controlClient = createCodexControlClient({
    peer,
    imageOptions: config,
    signal: linked.signal,
    ensureAlive,
    onBeforeInterruptTurn: (targetThreadId, turnId) => {
      if (targetThreadId === activeThreadId) interruptLocalCodexTurn(current, turnId);
    },
  });

  let threadId: string;
  let threadContext: CodexThreadContext;
  let dynamicOverrides: CodexThreadPolicyOverrides | undefined;
  try {
    if (config.prepareThread !== undefined) {
      dynamicOverrides = await raceAbort(
        Promise.resolve(
          config.prepareThread({
            controls: controlClient,
            cwd: input.cwd,
            ...(input.nativeThreadId !== undefined && {
              nativeThreadId: input.nativeThreadId,
            }),
            ...(input.forkFrom !== undefined && { forkFrom: input.forkFrom }),
          }),
        ),
        linked.signal,
      );
      linked.signal.throwIfAborted();
    }
    const openedReply = await openCodexThreadRpc(peer, config, input, dynamicOverrides);
    const openMethod =
      input.forkFrom !== undefined
        ? 'thread/fork'
        : input.nativeThreadId !== undefined
          ? 'thread/resume'
          : 'thread/start';
    const parsed = parseCodexResponse(openMethod, CodexStartedThreadSchema, openedReply);
    threadId = parsed.thread.id;
    activeThreadId = threadId;
    threadContext = extractCodexThreadContext(parsed);
    if (config.verifyThread !== undefined) {
      emitStartupPhase(input.onStartupPhase, 'verifying', config.onObserverError);
      await raceAbort(
        Promise.resolve(
          config.verifyThread({
            nativeThreadId: threadId,
            threadContext,
            controls: controlClient,
          }),
        ),
        linked.signal,
      );
      linked.signal.throwIfAborted();
    }
    if (liveness.lost !== undefined) throw liveness.lost.reason;
    linked.signal.throwIfAborted();
  } catch (error) {
    await stop({ error });
    throw error;
  }

  const activeModelProvider =
    threadContext.modelProvider ??
    dynamicOverrides?.modelProvider ??
    input.forkFrom?.modelProvider ??
    config.modelProvider;
  const startTurn = createCodexStartTurn({
    config,
    peer,
    threadId,
    activeModelProvider,
    signal: linked.signal,
    liveness,
    getTurn: () => current,
    setTurn: (turn) => {
      current = turn;
    },
  });
  const mutators = createCodexSessionMutators({
    peer,
    threadId,
    imageOptions: config,
    signal: linked.signal,
    ensureAlive,
    getActiveTurn: () => current,
  });

  opened = true;
  return {
    nativeThreadId: threadId,
    providerPid,
    userAgent,
    threadContext,
    startTurn,
    async respond(interactionId, reply) {
      answerCodexSessionRequest({
        liveness,
        turn: current,
        externalPending,
        interactionId,
        reply,
      });
    },
    ...controlClient,
    ...bindCodexSessionThreadControls(controlClient, threadId),
    ...mutators,
    async close() {
      await stop();
    },
  };
}

/** Open a threadless app-server connection (no `thread/start`) for metadata reads or external observation. */
export async function openCodexControlConnection(
  config: CodexSessionConfig,
  input: CodexControlConnectInput,
): Promise<CodexControlConnection> {
  const profile = engineProfile('codex', input.profile);
  const linked = sessionAbort(input.signal);
  const externalPending = new Map<string, PendingExternalCodexRequest>();
  let opened = false;
  const liveness = sessionLiveness({
    closedMessage: 'The Codex control connection is closed',
    caller: input.signal,
    linked: linked.signal,
  });
  const ensureAlive = () => liveness.ensureAlive();
  let connected: Awaited<ReturnType<typeof connectCodex>>;
  try {
    connected = await connectCodex(
      config,
      profile,
      input.cwd,
      linked.signal,
      createCodexHandlers({
        sharedWithOtherClients: codexTransportShared(config),
        profileId: profile.profileId,
        limits: config.limits,
        externalPending,
        liveness,
        closingGracefully: () => liveness.closingGracefully,
        getTurn: () => undefined,
        clearTurn: () => undefined,
        ...codexObserverOptions(config),
      }),
      (error) => {
        const { abortedByCaller } = liveness;
        const shouldNotify = opened && !liveness.closing && !abortedByCaller;
        if (!liveness.closing && !abortedByCaller) liveness.markLost(error);
        externalPending.clear();
        linked.abort();
        if (shouldNotify)
          invokeObserver(config.onObserverError, 'onDisconnect', () =>
            config.onDisconnect?.(error),
          );
      },
      input.onStartupPhase,
    );
  } catch (error) {
    linked.release();
    throw error;
  }
  const failedOpening = liveness.terminated();
  if (failedOpening !== undefined) {
    const { reason } = failedOpening;
    liveness.markClosing();
    externalPending.clear();
    try {
      await stopConnection(connected, { error: reason });
    } finally {
      linked.abort();
      linked.release();
    }
    throw reason;
  }
  const controlClient = createCodexControlClient({
    peer: connected.peer,
    imageOptions: config,
    signal: linked.signal,
    ensureAlive,
  });
  opened = true;
  return {
    providerPid: connected.providerPid,
    userAgent: connected.userAgent,
    ...controlClient,
    async respond(interactionId, reply) {
      answerCodexSessionRequest({
        liveness,
        turn: undefined,
        externalPending,
        interactionId,
        reply,
      });
    },
    async close() {
      liveness.markClosing();
      await releaseExternalCodexRequestsBeforeStop(
        [externalPending],
        liveness.closingGracefully && !codexTransportShared(config),
      );
      try {
        await stopConnection(connected);
      } finally {
        linked.abort();
        linked.release();
      }
    },
  };
}
