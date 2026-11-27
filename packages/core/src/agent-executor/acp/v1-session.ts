import type { z } from 'zod';
import type { AgentMessagePart } from '../../agent-parts/parts';
import { abortReason } from '../../internal/abort-race';
import type { AgentEngineSession } from '../engine';
import type { InteractionReply } from '../executor-contract';
import { DEFAULT_MAX_IMAGE_BYTES } from '../image-input';
import type { JsonRpcValue } from '../json-rpc-peer';
import type { ExecutorProfileConfig } from '../profile';
import {
  invokeObserver,
  type SessionLiveness,
  sessionAbort,
  sessionLiveness,
  stopConnection,
} from '../session-primitives';
import type { ExecutorStartupPhase } from '../vocabulary';
import {
  type AcpDriverConfig,
  acpCan,
  assertAcpDriverOptions,
  closeRequestTimeoutMs,
  connectAcp,
  extractAcpSessionMeta,
  resolveAcpSessionMeta,
} from './v1-connect';
import { createAcpHandlers } from './v1-handlers';
import {
  answerAcpSessionRequest,
  drainExternalAcpPending,
  type PendingExternalAcpRequest,
} from './v1-permission';
import {
  type AcpConfigOption,
  type AcpInitializeResult,
  AcpMcpServerSchema,
  AcpNewSessionResultSchema,
  AcpSessionStateSchema,
} from './v1-protocol';
import {
  applyAcpSessionSelections,
  mergeInitialAcpConfigOptions,
  setAcpConfigOption,
} from './v1-session-options';
import { type AcpTurnSlot, createAcpTurnControls, settleAcpTurn } from './v1-turn';

/**
 * How tool approvals are enforced over ACP: `'agent-initiated'` means the driver answers
 * `session/request_permission` requests when the agent sends them, but cannot compel an agent
 * to ask before running tools and never synthesizes fake requests after `tool_call` updates.
 */
export type AcpApprovalEnforcement = 'agent-initiated';

/** Input to {@link AcpDriver.open}, extending {@link AgentEngineDriver.open} with per-session overrides. */
export interface AcpOpenInput {
  readonly profile: ExecutorProfileConfig;
  readonly cwd: string;
  /** Resume or load this native session; a fresh one is started without it. */
  readonly nativeThreadId?: string | undefined;
  /** Per-session model override (overrides {@link AcpDriverConfig.model}). */
  readonly model?: string | undefined;
  /** Per-session thought level override (overrides {@link AcpDriverConfig.thoughtLevel}). */
  readonly thoughtLevel?: string | undefined;
  /** Per-session mode override (overrides {@link AcpDriverConfig.mode}). */
  readonly mode?: string | undefined;
  /** Optional observer invoked with startup phases (`spawning`, `initializing`) during open. */
  readonly onStartupPhase?: ((phase: ExecutorStartupPhase) => void) | undefined;
  readonly signal?: AbortSignal | undefined;
}

/** Input to {@link AcpSession.steerTurn} when `steerMode` is `'prompt'`. */
export interface AcpSteerTurnInput {
  readonly input: readonly AgentMessagePart[];
}

/** A session with what ACP says about it besides turns: its PID, settings, title, commands, steering, and post-settle replies. */
export interface AcpSession extends AgentEngineSession {
  /** OS process id of the active spawned ACP child, or `undefined` once the session has exited or closed. */
  readonly providerPid: number | undefined;
  /** Always `'agent-initiated'`: whether a tool pauses for host approval is decided by the agent. */
  readonly approvalEnforcement: AcpApprovalEnforcement;
  /**
   * What this session's agent process answered to `initialize`, as `probeCapabilities` returns it:
   * `agentCapabilities.promptCapabilities` says what the agent itself declares (images, audio),
   * where `driver.capabilities` says what the driver can send.
   */
  readonly initialized: AcpInitializeResult;
  /** The agent's settings as last reported: on open, on a change, and on `config_option_update`. */
  readonly configOptions: readonly AcpConfigOption[];
  /** The title the agent gave the session, once it did. */
  readonly title: string | undefined;
  /** The slash commands the agent offers, by name. */
  readonly commands: readonly string[];
  /** Optional `_meta` object returned by the agent in its `session/new`, `session/resume`, or `session/load` response. */
  readonly sessionMeta?: Readonly<Record<string, JsonRpcValue>>;
  /** Change one setting; the agent answers with every option, which may have narrowed. */
  setConfigOption(configId: string, value: string): Promise<readonly AcpConfigOption[]>;
  /** Answer a pending permission request from either the active turn or a post-settle `onPermissionRequest` event. */
  respond(interactionId: string, reply: InteractionReply['reply']): Promise<void>;
  /**
   * Steer the currently running turn with an additional `session/prompt` generation when
   * `steerMode` is `'prompt'`. Throws `TypeError` when `steerMode` is `'none'` (default). It
   * resolves once the prompt is sent: an agent that refuses it while an earlier prompt runs is told
   * on the turn as a non-terminal `error` delta (`itemId` `steer-refused:<generation>`), and the
   * turn stays with that earlier prompt.
   */
  steerTurn(input: AcpSteerTurnInput): Promise<{ readonly turnId: string }>;
}

interface AcpSessionState {
  current: AcpTurnSlot | undefined;
  opened: boolean;
  livePid: number | undefined;
  pidNotified: boolean;
  configOptions: readonly AcpConfigOption[];
  sawConfigOptionUpdate: boolean;
  title: string | undefined;
  commands: readonly string[];
}

function createAcpSessionClose(input: {
  readonly config: AcpDriverConfig;
  readonly connected: Awaited<ReturnType<typeof connectAcp>>;
  readonly sessionId: string;
  readonly liveness: SessionLiveness;
  readonly linked: ReturnType<typeof sessionAbort>;
  readonly externalPending: Map<string, PendingExternalAcpRequest>;
  readonly state: AcpSessionState;
  readonly stop: (primary?: { error: unknown }) => Promise<void>;
}): () => Promise<void> {
  const { state, liveness, linked, externalPending } = input;
  let closePromise: Promise<void> | undefined;
  return () => {
    if (closePromise !== undefined) return closePromise;
    closePromise = (async () => {
      const terminated = liveness.terminated();
      const alreadyTerminated = terminated !== undefined;
      const closeReason =
        terminated === undefined ? new Error('The ACP session is closing') : terminated.reason;
      liveness.markClosing();
      const turn = state.current;
      state.current = undefined;
      settleAcpTurn(turn, closeReason, !alreadyTerminated);
      if (alreadyTerminated) externalPending.clear();
      else drainExternalAcpPending(externalPending);
      if (!alreadyTerminated && acpCan(input.connected, 'close')) {
        await input.connected.peer
          .request(
            'session/close',
            { sessionId: input.sessionId },
            { timeoutMs: closeRequestTimeoutMs(input.config), signal: linked.signal },
          )
          .catch(() => undefined);
      }
      await input.stop();
    })();
    return closePromise;
  };
}

async function openOrReopenAcpSession(input: {
  connected: Awaited<ReturnType<typeof connectAcp>>;
  cwd: string;
  nativeThreadId: string | undefined;
  mcpServers: z.infer<typeof AcpMcpServerSchema>[];
  meta: ReturnType<typeof resolveAcpSessionMeta>;
  signal: AbortSignal;
}): Promise<{
  readonly sessionId: string;
  readonly configOptions: readonly AcpConfigOption[] | null | undefined;
  readonly models: z.infer<typeof AcpSessionStateSchema>['models'];
  readonly sessionMeta: Readonly<Record<string, JsonRpcValue>> | undefined;
}> {
  const { connected, cwd, nativeThreadId, mcpServers, meta, signal } = input;
  if (nativeThreadId === undefined) {
    const created = AcpNewSessionResultSchema.parse(
      await connected.peer.request(
        'session/new',
        {
          cwd,
          mcpServers,
          ...(meta !== undefined && { _meta: meta }),
        },
        { signal },
      ),
    );
    return {
      sessionId: created.sessionId,
      configOptions: created.configOptions,
      models: created.models,
      sessionMeta: extractAcpSessionMeta(created._meta),
    };
  }
  // `resume` reopens without replaying the history; `load` replays it.
  const method = acpCan(connected, 'resume') ? 'session/resume' : 'session/load';
  const reopened = AcpSessionStateSchema.parse(
    (await connected.peer.request(
      method,
      {
        sessionId: nativeThreadId,
        cwd,
        mcpServers,
        ...(meta !== undefined && { _meta: meta }),
      },
      { signal },
    )) ?? {},
  );
  return {
    sessionId: nativeThreadId,
    configOptions: reopened.configOptions,
    models: reopened.models,
    sessionMeta: extractAcpSessionMeta(reopened._meta),
  };
}

function buildAcpSession(input: {
  readonly config: AcpDriverConfig;
  readonly connected: Awaited<ReturnType<typeof connectAcp>>;
  readonly sessionId: string;
  readonly sessionMeta: Readonly<Record<string, JsonRpcValue>> | undefined;
  readonly liveness: SessionLiveness;
  readonly linked: ReturnType<typeof sessionAbort>;
  readonly externalPending: Map<string, PendingExternalAcpRequest>;
  readonly state: AcpSessionState;
  readonly stop: (primary?: { error: unknown }) => Promise<void>;
}): AcpSession {
  const {
    config,
    connected,
    sessionId,
    sessionMeta,
    liveness,
    linked,
    externalPending,
    state,
    stop,
  } = input;
  const { peer, initialized } = connected;
  const limits = {
    images: initialized.agentCapabilities?.promptCapabilities?.image === true,
    maxImageBytes: config.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES,
    ...(config.resolveFile && { resolveFile: config.resolveFile }),
  };
  const turnControls = createAcpTurnControls({
    config,
    peer,
    sessionId,
    limits,
    liveness,
    getTurn: () => state.current,
    setTurn: (turn) => {
      state.current = turn;
    },
  });
  const close = createAcpSessionClose({
    config,
    connected,
    sessionId,
    liveness,
    linked,
    externalPending,
    state,
    stop,
  });
  liveness.ensureAlive();
  state.opened = true;
  return {
    nativeThreadId: sessionId,
    get providerPid() {
      return liveness.isAlive() ? state.livePid : undefined;
    },
    approvalEnforcement: 'agent-initiated',
    initialized,
    get configOptions() {
      return state.configOptions;
    },
    get title() {
      return state.title;
    },
    get commands() {
      return state.commands;
    },
    ...(sessionMeta !== undefined && { sessionMeta }),
    async setConfigOption(configId, value) {
      liveness.ensureAlive();
      state.configOptions = await setAcpConfigOption(
        peer,
        sessionId,
        state.configOptions,
        configId,
        value,
        linked.signal,
      );
      return state.configOptions;
    },
    async respond(interactionId, reply) {
      answerAcpSessionRequest({
        liveness,
        turn: state.current,
        externalPending,
        interactionId,
        reply,
      });
    },
    ...turnControls,
    close,
  };
}

export async function openAcpSession(
  config: AcpDriverConfig,
  input: AcpOpenInput,
): Promise<AcpSession> {
  assertAcpDriverOptions(config);
  const mcpServers = (config.mcpServers ?? []).map((server) =>
    AcpMcpServerSchema.parse(server),
  );
  const linked = sessionAbort(input.signal);
  const externalPending = new Map<string, PendingExternalAcpRequest>();
  const state: AcpSessionState = {
    current: undefined,
    opened: false,
    livePid: undefined,
    pidNotified: false,
    configOptions: [],
    sawConfigOptionUpdate: false,
    title: undefined,
    commands: [],
  };
  let connected: Awaited<ReturnType<typeof connectAcp>>;
  const liveness = sessionLiveness({
    closedMessage: 'The ACP session is closing',
    caller: input.signal,
    linked: linked.signal,
  });
  const recordPid = (pid: number | undefined) => {
    if (pid === undefined || !liveness.isAlive()) return;
    state.livePid = pid;
    if (!state.pidNotified && config.onProviderPid !== undefined) {
      state.pidNotified = true;
      invokeObserver(config.onObserverError, 'onProviderPid', () =>
        config.onProviderPid?.(pid),
      );
    }
  };
  try {
    connected = await connectAcp(config, input.profile, input.cwd, linked.signal, {
      ...createAcpHandlers({
        externalPending,
        liveness,
        isOpened: () => state.opened,
        getTurn: () => state.current,
        onSessionMeta(meta) {
          if (meta.configOptions !== undefined) {
            state.configOptions = meta.configOptions;
            state.sawConfigOptionUpdate = true;
          }
          if (meta.title !== undefined) state.title = meta.title;
          if (meta.commands !== undefined) state.commands = meta.commands;
        },
        ...(config.transformUpdate !== undefined && {
          transformUpdate: config.transformUpdate,
        }),
        ...(config.onUpdate !== undefined && { onUpdate: config.onUpdate }),
        ...(config.onPermissionRequest !== undefined && {
          onPermissionRequest: config.onPermissionRequest,
        }),
        ...(config.permissionRequestDelivery !== undefined && {
          permissionRequestDelivery: config.permissionRequestDelivery,
        }),
        ...(config.onObserverError !== undefined && {
          onObserverError: config.onObserverError,
        }),
        closingGracefully: () => liveness.closingGracefully,
        onEnd(error) {
          const { abortedByCaller } = liveness;
          const shouldNotify = state.opened && !liveness.closing && !abortedByCaller;
          if (!liveness.closing && !abortedByCaller) liveness.markLost(error);
          state.livePid = undefined;
          const turn = state.current;
          state.current = undefined;
          externalPending.clear();
          settleAcpTurn(
            turn,
            abortedByCaller && input.signal !== undefined ? abortReason(input.signal) : error,
            !abortedByCaller,
          );
          // The session is over: nothing follows the caller's signal any more.
          linked.abort();
          if (shouldNotify)
            invokeObserver(config.onObserverError, 'onDisconnect', () =>
              config.onDisconnect?.(error),
            );
        },
      }),
      onProviderPid: recordPid,
      ...(input.onStartupPhase !== undefined && { onStartupPhase: input.onStartupPhase }),
    });
    if (state.livePid === undefined && liveness.isAlive()) {
      recordPid((await connected.engine.pidReady) ?? connected.engine.pid);
    }
  } catch (error) {
    linked.release();
    throw error;
  }
  const { peer, initialized } = connected;
  const stop = async (primary?: { error: unknown }) => {
    const terminated = liveness.terminated() !== undefined;
    liveness.markClosing();
    state.livePid = undefined;
    if (terminated) externalPending.clear();
    else drainExternalAcpPending(externalPending);
    linked.abort();
    try {
      await stopConnection(connected, primary);
    } finally {
      linked.release();
    }
  };
  try {
    const meta = resolveAcpSessionMeta(config.sessionMeta, initialized);
    const openedSession = await openOrReopenAcpSession({
      connected,
      cwd: input.cwd,
      nativeThreadId: input.nativeThreadId,
      mcpServers,
      meta,
      signal: linked.signal,
    });
    const sessionId = openedSession.sessionId;
    state.configOptions = mergeInitialAcpConfigOptions(
      state.configOptions,
      openedSession.configOptions,
      state.sawConfigOptionUpdate,
    );
    const desiredModel = input.model ?? config.model;
    const desiredThoughtLevel = input.thoughtLevel ?? config.thoughtLevel;
    const desiredMode = input.mode ?? config.mode;
    state.configOptions = await applyAcpSessionSelections({
      peer,
      sessionId,
      configOptions: state.configOptions,
      models: openedSession.models,
      signal: linked.signal,
      ...(desiredModel !== undefined && { model: desiredModel }),
      ...(desiredThoughtLevel !== undefined && { thoughtLevel: desiredThoughtLevel }),
      ...(desiredMode !== undefined && { mode: desiredMode }),
    });
    return buildAcpSession({
      config,
      connected,
      sessionId,
      sessionMeta: openedSession.sessionMeta,
      liveness,
      linked,
      externalPending,
      state,
      stop,
    });
  } catch (error) {
    await stop({ error });
    throw error;
  }
}
