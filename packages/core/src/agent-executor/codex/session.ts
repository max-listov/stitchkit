import { abortReason, raceAbort } from '../../internal/abort-race';
import { loseEngineTurn } from '../engine-requests';
import { engineProfile } from '../profile';
import {
  emitStartupPhase,
  invokeSafely,
  sessionAbort,
  stopConnection,
} from '../session-primitives';
import { connectCodex } from './connect';
import {
  type CodexControlConnectInput,
  type CodexControlConnection,
  createCodexControlClient,
} from './control-client';
import { discardStartingTurn } from './event-routing';
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
  let dead: Error | undefined;
  let opened = false;
  let closing = false;
  const ensureAlive = () => {
    if (closing) throw new Error('The Codex session is closed');
    if (dead !== undefined) throw dead;
    if (linked.signal.aborted) throw abortReason(linked.signal);
  };
  let connected: Awaited<ReturnType<typeof connectCodex>>;
  try {
    connected = await connectCodex(
      config,
      profile,
      input.cwd,
      linked.signal,
      createCodexHandlers({
        profileId: profile.profileId,
        limits: config.limits,
        externalPending,
        ensureAlive,
        getTurn: () => current,
        clearTurn: () => {
          current = undefined;
        },
        ...(config.onNotification !== undefined && { onNotification: config.onNotification }),
        ...(config.onServerRequest !== undefined && {
          onServerRequest: config.onServerRequest,
        }),
        ...(config.serverRequestDelivery !== undefined && {
          serverRequestDelivery: config.serverRequestDelivery,
        }),
      }),
      (error) => {
        const shouldNotify = opened && !closing && input.signal?.aborted !== true;
        dead = error;
        const turn = current;
        current = undefined;
        discardStartingTurn(turn);
        // Never send `cancel` for external TUI requests when our observer disconnects.
        externalPending.clear();
        loseEngineTurn(turn, codexStopped, error);
        linked.abort();
        if (shouldNotify) invokeSafely(() => config.onDisconnect?.(error));
      },
      input.onStartupPhase,
    );
  } catch (error) {
    linked.release();
    throw error;
  }
  const { peer, providerPid, userAgent } = connected;
  const stop = async (primary?: { error: unknown }) => {
    closing = true;
    discardStartingTurn(current);
    externalPending.clear();
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
      emitStartupPhase(input.onStartupPhase, 'verifying');
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
    if (dead !== undefined) throw dead;
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
    ensureAlive,
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
      ensureAlive();
      answerCodexSessionRequest({ turn: current, externalPending, interactionId, reply });
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
  let dead: Error | undefined;
  let opened = false;
  let closing = false;
  const ensureAlive = () => {
    if (closing) throw new Error('The Codex control connection is closed');
    if (dead !== undefined) throw dead;
    if (linked.signal.aborted) throw abortReason(linked.signal);
  };
  let connected: Awaited<ReturnType<typeof connectCodex>>;
  try {
    connected = await connectCodex(
      config,
      profile,
      input.cwd,
      linked.signal,
      createCodexHandlers({
        profileId: profile.profileId,
        limits: config.limits,
        externalPending,
        ensureAlive,
        getTurn: () => undefined,
        clearTurn: () => undefined,
        ...(config.onNotification !== undefined && { onNotification: config.onNotification }),
        ...(config.onServerRequest !== undefined && {
          onServerRequest: config.onServerRequest,
        }),
        ...(config.serverRequestDelivery !== undefined && {
          serverRequestDelivery: config.serverRequestDelivery,
        }),
      }),
      (error) => {
        const shouldNotify = opened && !closing && input.signal?.aborted !== true;
        dead = error;
        externalPending.clear();
        linked.abort();
        if (shouldNotify) invokeSafely(() => config.onDisconnect?.(error));
      },
      input.onStartupPhase,
    );
  } catch (error) {
    linked.release();
    throw error;
  }
  if (dead !== undefined || linked.signal.aborted) {
    const reason = dead ?? abortReason(linked.signal);
    closing = true;
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
      ensureAlive();
      answerCodexSessionRequest({ turn: undefined, externalPending, interactionId, reply });
    },
    async close() {
      closing = true;
      externalPending.clear();
      try {
        await stopConnection(connected);
      } finally {
        linked.abort();
        linked.release();
      }
    },
  };
}
