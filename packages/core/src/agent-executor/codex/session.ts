import { abortReason, raceAbort } from '../../internal/abort-race';
import type { AgentEngineTurn } from '../engine';
import { drainEngineRequests, loseEngineTurn } from '../engine-requests';
import type { PlanLimits } from '../hello';
import { type DriverImageOptions, guardedTurnStarter } from '../image-input';
import type { JsonRpcPeer, JsonRpcValue } from '../json-rpc-peer';
import { engineProfile } from '../profile';
import {
  createTurnDeltaChannel,
  emitStartupPhase,
  invokeSafely,
  sessionAbort,
  stopConnection,
} from '../session-primitives';
import { type CodexConnectConfig, connectCodex } from './connect';
import {
  bindCodexSessionThreadControls,
  type CodexControlClient,
  type CodexControlConnectInput,
  type CodexControlConnection,
  createCodexControlClient,
} from './control-client';
import {
  type CodexNotificationEvent,
  type CodexServerRequestEvent,
  createCodexHandlers,
} from './handlers';
import {
  CodexStartedThreadSchema,
  CodexStartedTurnSchema,
  type CodexThreadContext,
  extractCodexThreadContext,
} from './protocol';
import {
  answerActiveCodexTurnRequest,
  answerCodexSessionRequest,
  type CodexTurnSlot,
  codexStopped,
  type PendingExternalCodexRequest,
} from './request-answers';
import {
  buildCodexThreadPolicyParams,
  buildCodexTurnStartParams,
  type CodexOpenForkOptions,
  type CodexOpenInput,
  type CodexSession,
  type CodexThreadPolicyOverrides,
  type CodexTurnInput,
  createCodexSessionMutators,
  validateCodexForkBounds,
  validateCodexPolicyOverrides,
  validateCodexTurnStartOverrides,
} from './session-controls';
import { inlineCodexParts } from './turn-input';

export interface CodexSessionConfig extends DriverImageOptions, CodexConnectConfig {
  readonly model?: string;
  readonly modelProvider?: string;
  readonly approvalPolicy: CodexThreadPolicyOverrides['approvalPolicy'];
  readonly sandbox: CodexThreadPolicyOverrides['sandbox'];
  readonly developerInstructions?: string;
  readonly runtimeWorkspaceRoots?: readonly string[];
  readonly config?: Readonly<Record<string, JsonRpcValue>>;
  readonly prepareThread?: (context: {
    readonly controls: CodexControlClient;
    readonly cwd: string;
    readonly nativeThreadId?: string;
    readonly forkFrom?: CodexOpenForkOptions;
  }) =>
    | Promise<CodexThreadPolicyOverrides | undefined>
    | CodexThreadPolicyOverrides
    | undefined;
  readonly verifyThread?: (context: {
    readonly nativeThreadId: string;
    readonly threadContext: CodexThreadContext;
    readonly controls: CodexControlClient;
  }) => Promise<void> | void;
  readonly onNotification?: (event: CodexNotificationEvent) => void;
  readonly onServerRequest?: (event: CodexServerRequestEvent) => void;
  readonly onDisconnect?: (error: Error) => void;
  readonly limits: Map<string, PlanLimits>;
}

export function createCodexStartTurn(input: {
  config: CodexSessionConfig;
  peer: JsonRpcPeer;
  threadId: string;
  activeModelProvider: string | undefined;
  signal: AbortSignal;
  ensureAlive(): void;
  getTurn(): CodexTurnSlot | undefined;
  setTurn(turn: CodexTurnSlot | undefined): void;
}): (turnInput: CodexTurnInput) => Promise<AgentEngineTurn> {
  return guardedTurnStarter({
    busyMessage: 'A turn is already running in this Codex thread',
    check: (turnInput: CodexTurnInput) => {
      input.ensureAlive();
      if (input.getTurn() !== undefined) {
        throw new Error('A turn is already running in this Codex thread');
      }
      validateCodexTurnStartOverrides(turnInput, input.activeModelProvider);
    },
    inline: (turnInput) =>
      inlineCodexParts(turnInput.input, {
        ...input.config,
        driverLabel: 'The Codex driver',
        signal: input.signal,
      }),
    dispatch: async (turnInput, parts) => {
      const turnParams = buildCodexTurnStartParams(
        input.threadId,
        turnInput,
        parts,
        input.activeModelProvider,
      );
      const turn: CodexTurnSlot = {
        state: { turnId: turnInput.turnId, interruptRequested: false },
        channel: createTurnDeltaChannel(),
        pending: new Map(),
      };
      input.setTurn(turn);
      try {
        const started = await input.peer.request('turn/start', turnParams);
        turn.codexTurnId = CodexStartedTurnSchema.parse(started).turn.id;
      } catch (error) {
        if (input.getTurn() === turn) input.setTurn(undefined);
        throw error;
      }
      return {
        deltas: turn.channel,
        async interrupt() {
          turn.state.interruptRequested = true;
          drainEngineRequests(turn, codexStopped);
          if (turn.codexTurnId !== undefined) {
            await input.peer.request('turn/interrupt', {
              threadId: input.threadId,
              turnId: turn.codexTurnId,
            });
          }
        },
        async respond(interactionId, rawReply) {
          answerActiveCodexTurnRequest(turn, interactionId, rawReply);
        },
      };
    },
  });
}

export function validateCodexOpenInput(input: CodexOpenInput): void {
  if (input.nativeThreadId !== undefined && input.forkFrom !== undefined) {
    throw new TypeError(
      '[stitchkit] CodexDriver.open: nativeThreadId and forkFrom are mutually exclusive',
    );
  }
  if (input.forkFrom !== undefined) {
    if (
      typeof input.forkFrom.threadId !== 'string' ||
      input.forkFrom.threadId.trim().length === 0
    ) {
      throw new TypeError(
        '[stitchkit] CodexDriver.open: forkFrom.threadId must be a non-empty string',
      );
    }
    validateCodexForkBounds(input.forkFrom, 'CodexDriver.open');
    validateCodexPolicyOverrides(input.forkFrom, 'CodexDriver.open');
  }
}

export function mergeOpenThreadPolicy(
  config: CodexSessionConfig,
  forkFrom: CodexOpenForkOptions | undefined,
  dynamicOverrides: CodexThreadPolicyOverrides | undefined,
): Record<string, JsonRpcValue> {
  const basePolicy: CodexThreadPolicyOverrides = {
    ...(config.model !== undefined && { model: config.model }),
    ...(config.modelProvider !== undefined && { modelProvider: config.modelProvider }),
    ...(config.approvalPolicy !== undefined && { approvalPolicy: config.approvalPolicy }),
    ...(config.sandbox !== undefined && { sandbox: config.sandbox }),
    ...(config.developerInstructions !== undefined && {
      developerInstructions: config.developerInstructions,
    }),
    ...(config.runtimeWorkspaceRoots !== undefined && {
      runtimeWorkspaceRoots: config.runtimeWorkspaceRoots,
    }),
    ...(config.config !== undefined && { config: config.config }),
  };
  const withFork: CodexThreadPolicyOverrides =
    forkFrom === undefined
      ? basePolicy
      : {
          ...basePolicy,
          ...(forkFrom.model !== undefined && { model: forkFrom.model }),
          ...(forkFrom.modelProvider !== undefined && {
            modelProvider: forkFrom.modelProvider,
          }),
          ...(forkFrom.approvalPolicy !== undefined && {
            approvalPolicy: forkFrom.approvalPolicy,
          }),
          ...(forkFrom.sandbox !== undefined && { sandbox: forkFrom.sandbox }),
          ...(forkFrom.developerInstructions !== undefined && {
            developerInstructions: forkFrom.developerInstructions,
          }),
          ...(forkFrom.runtimeWorkspaceRoots !== undefined && {
            runtimeWorkspaceRoots: forkFrom.runtimeWorkspaceRoots,
          }),
          ...(basePolicy.config !== undefined || forkFrom.config !== undefined
            ? { config: { ...(basePolicy.config ?? {}), ...(forkFrom.config ?? {}) } }
            : {}),
        };
  return buildCodexThreadPolicyParams(withFork, dynamicOverrides);
}

/** Dispatch `thread/fork`, `thread/resume`, or `thread/start` with merged policy overrides. */
export function openCodexThreadRpc(
  peer: JsonRpcPeer,
  config: CodexSessionConfig,
  input: {
    readonly cwd: string;
    readonly nativeThreadId?: string;
    readonly forkFrom?: CodexOpenForkOptions;
  },
  dynamicOverrides: CodexThreadPolicyOverrides | undefined,
): Promise<JsonRpcValue> {
  const threadParams: Record<string, JsonRpcValue> = {
    cwd: input.cwd,
    ...mergeOpenThreadPolicy(config, input.forkFrom, dynamicOverrides),
  };
  if (input.forkFrom !== undefined) {
    const fork = input.forkFrom;
    return peer.request('thread/fork', {
      threadId: fork.threadId,
      excludeTurns: fork.excludeTurns ?? true,
      ...threadParams,
      ...(fork.beforeTurnId !== undefined && { beforeTurnId: fork.beforeTurnId }),
      ...(fork.lastTurnId !== undefined && { lastTurnId: fork.lastTurnId }),
      ...(fork.deferGoalContinuation !== undefined && {
        deferGoalContinuation: fork.deferGoalContinuation,
      }),
    });
  }
  if (input.nativeThreadId !== undefined) {
    return peer.request('thread/resume', {
      threadId: input.nativeThreadId,
      excludeTurns: true,
      ...threadParams,
    });
  }
  return peer.request('thread/start', threadParams);
}

/**
 * One app-server connection holding one thread. Server requests during `startTurn()` become
 * `request` deltas answered by `respond`; external/TUI requests route through `onServerRequest`
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
  let dead: Error | undefined;
  let opened = false;
  let closing = false;
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
        getTurn: () => current,
        clearTurn: () => {
          current = undefined;
        },
        ...(config.onNotification !== undefined && { onNotification: config.onNotification }),
        ...(config.onServerRequest !== undefined && {
          onServerRequest: config.onServerRequest,
        }),
      }),
      (error) => {
        const shouldNotify = opened && !closing && input.signal?.aborted !== true;
        dead = error;
        const turn = current;
        current = undefined;
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
  const { peer, providerPid } = connected;
  const ensureAlive = () => {
    if (closing) throw new Error('The Codex session is closed');
    if (dead !== undefined) throw dead;
  };
  const stop = async (primary?: { error: unknown }) => {
    closing = true;
    externalPending.clear();
    try {
      await stopConnection(connected, primary);
    } finally {
      linked.abort();
      linked.release();
    }
  };
  const controlClient = createCodexControlClient({ peer, ensureAlive });

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
    const parsed = CodexStartedThreadSchema.parse(openedReply);
    threadId = parsed.thread.id;
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
        getTurn: () => undefined,
        clearTurn: () => undefined,
        ...(config.onNotification !== undefined && { onNotification: config.onNotification }),
        ...(config.onServerRequest !== undefined && {
          onServerRequest: config.onServerRequest,
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
  const ensureAlive = () => {
    if (closing) throw new Error('The Codex control connection is closed');
    if (dead !== undefined) throw dead;
  };
  const controlClient = createCodexControlClient({ peer: connected.peer, ensureAlive });
  opened = true;
  return {
    providerPid: connected.providerPid,
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
