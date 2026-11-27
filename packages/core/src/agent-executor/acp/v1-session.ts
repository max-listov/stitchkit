import type { z } from 'zod';
import type { AgentMessagePart } from '../../agent-parts/parts';
import type { AgentEngineSession } from '../engine';
import { loseEngineTurn } from '../engine-requests';
import type { InteractionReply } from '../executor-contract';
import { DEFAULT_MAX_IMAGE_BYTES } from '../image-input';
import type { JsonRpcPeer } from '../json-rpc-peer';
import type { ExecutorProfileConfig } from '../profile';
import { invokeSafely, sessionAbort, stopConnection } from '../session-primitives';
import type { ExecutorStartupPhase } from '../vocabulary';
import {
  type AcpDriverConfig,
  acpCan,
  assertAcpDriverOptions,
  closeRequestTimeoutMs,
  connectAcp,
  resolveAcpSessionMeta,
} from './v1-connect';
import { createAcpHandlers } from './v1-handlers';
import {
  ACP_CANCELLED,
  answerAcpSessionRequest,
  type PendingExternalAcpRequest,
} from './v1-permission';
import {
  type AcpConfigOption,
  AcpMcpServerSchema,
  AcpNewSessionResultSchema,
  AcpSessionStateSchema,
  AcpSetConfigOptionResultSchema,
  acpOptionValues,
} from './v1-protocol';
import { type AcpTurnSlot, createAcpTurnControls } from './v1-turn';

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
  /** The agent's settings as last reported: on open, on a change, and on `config_option_update`. */
  readonly configOptions: readonly AcpConfigOption[];
  /** The title the agent gave the session, once it did. */
  readonly title: string | undefined;
  /** The slash commands the agent offers, by name. */
  readonly commands: readonly string[];
  /** Change one setting; the agent answers with every option, which may have narrowed. */
  setConfigOption(configId: string, value: string): Promise<readonly AcpConfigOption[]>;
  /** Answer a pending permission request from either the active turn or a post-settle `onPermissionRequest` event. */
  respond(interactionId: string, reply: InteractionReply['reply']): Promise<void>;
  /**
   * Steer the currently running turn with an additional `session/prompt` generation when
   * `steerMode` is `'prompt'`. Throws `TypeError` when `steerMode` is `'none'` (default).
   */
  steerTurn(input: AcpSteerTurnInput): Promise<{ readonly turnId: string }>;
}

/** The option of a category (`model`, `thought_level`, `mode`), or the one with that id. */
function optionOf(options: readonly AcpConfigOption[], category: string) {
  return (
    options.find((option) => option.category === category) ??
    options.find((option) => option.id === category)
  );
}

async function setOption(
  peer: JsonRpcPeer,
  sessionId: string,
  options: readonly AcpConfigOption[],
  category: string,
  value: string,
): Promise<readonly AcpConfigOption[]> {
  const option = optionOf(options, category);
  if (option === undefined) throw new Error(`The ACP agent offers no ${category} option`);
  const values = acpOptionValues(option);
  if (values.length > 0 && !values.includes(value)) {
    throw new Error(
      `The ACP agent's ${category} option has no value ${value} (offered: ${values.join(', ')})`,
    );
  }
  const answer = AcpSetConfigOptionResultSchema.parse(
    await peer.request('session/set_config_option', { sessionId, configId: option.id, value }),
  );
  return answer.configOptions ?? options;
}

async function applySessionSelections(input: {
  peer: JsonRpcPeer;
  sessionId: string;
  configOptions: readonly AcpConfigOption[];
  models: z.infer<typeof AcpSessionStateSchema>['models'];
  model?: string;
  thoughtLevel?: string;
  mode?: string;
}): Promise<readonly AcpConfigOption[]> {
  let options = input.configOptions;
  if (input.model !== undefined) {
    if (optionOf(options, 'model') !== undefined) {
      options = await setOption(input.peer, input.sessionId, options, 'model', input.model);
    } else if (input.models !== undefined && input.models !== null) {
      const available = input.models.availableModels?.map((entry) => entry.modelId) ?? [];
      if (available.length > 0 && !available.includes(input.model)) {
        throw new Error(
          `The ACP agent's model option has no value ${input.model} (offered: ${available.join(', ')})`,
        );
      }
      await input.peer.request('session/set_model', {
        sessionId: input.sessionId,
        modelId: input.model,
      });
    } else {
      throw new Error('The ACP agent offers no model option');
    }
  }
  if (input.thoughtLevel !== undefined) {
    options = await setOption(
      input.peer,
      input.sessionId,
      options,
      'thought_level',
      input.thoughtLevel,
    );
  }
  if (input.mode !== undefined) {
    options = await setOption(input.peer, input.sessionId, options, 'mode', input.mode);
  }
  return options;
}

function drainExternalPending(externalPending: Map<string, PendingExternalAcpRequest>): void {
  for (const [interactionId, pending] of [...externalPending]) {
    externalPending.delete(interactionId);
    pending.resolve(ACP_CANCELLED);
  }
}

function mergeInitialConfigOptions(
  current: readonly AcpConfigOption[],
  incoming: readonly AcpConfigOption[] | null | undefined,
  sawConfigOptionUpdate: boolean,
): readonly AcpConfigOption[] {
  if (incoming == null) return current;
  if (!sawConfigOptionUpdate || (current.length === 0 && incoming.length > 0)) {
    return incoming;
  }
  return current;
}

async function openOrReopenAcpSession(input: {
  connected: Awaited<ReturnType<typeof connectAcp>>;
  cwd: string;
  nativeThreadId: string | undefined;
  mcpServers: z.infer<typeof AcpMcpServerSchema>[];
  meta: ReturnType<typeof resolveAcpSessionMeta>;
}): Promise<{
  readonly sessionId: string;
  readonly configOptions: readonly AcpConfigOption[] | null | undefined;
  readonly models: z.infer<typeof AcpSessionStateSchema>['models'];
}> {
  const { connected, cwd, nativeThreadId, mcpServers, meta } = input;
  if (nativeThreadId === undefined) {
    const created = AcpNewSessionResultSchema.parse(
      await connected.peer.request('session/new', {
        cwd,
        mcpServers,
        ...(meta !== undefined && { _meta: meta }),
      }),
    );
    return {
      sessionId: created.sessionId,
      configOptions: created.configOptions,
      models: created.models,
    };
  }
  // `resume` reopens without replaying the history; `load` replays it.
  const method = acpCan(connected, 'resume') ? 'session/resume' : 'session/load';
  const reopened = AcpSessionStateSchema.parse(
    (await connected.peer.request(method, {
      sessionId: nativeThreadId,
      cwd,
      mcpServers,
      ...(meta !== undefined && { _meta: meta }),
    })) ?? {},
  );
  return {
    sessionId: nativeThreadId,
    configOptions: reopened.configOptions,
    models: reopened.models,
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
  let current: AcpTurnSlot | undefined;
  let opened = false;
  let closing = false;
  let dead: Error | undefined;
  let livePid: number | undefined;
  let pidNotified = false;
  let configOptions: readonly AcpConfigOption[] = [];
  let sawConfigOptionUpdate = false;
  let title: string | undefined;
  let commands: readonly string[] = [];
  let connected: Awaited<ReturnType<typeof connectAcp>>;
  const recordPid = (pid: number | undefined) => {
    if (pid === undefined || closing || dead !== undefined) return;
    livePid = pid;
    if (!pidNotified && config.onProviderPid !== undefined) {
      pidNotified = true;
      invokeSafely(() => config.onProviderPid?.(pid));
    }
  };
  try {
    connected = await connectAcp(config, input.profile, input.cwd, linked.signal, {
      ...createAcpHandlers({
        externalPending,
        isOpened: () => opened,
        getTurn: () => current,
        onSessionMeta(meta) {
          if (meta.configOptions !== undefined) {
            configOptions = meta.configOptions;
            sawConfigOptionUpdate = true;
          }
          if (meta.title !== undefined) title = meta.title;
          if (meta.commands !== undefined) commands = meta.commands;
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
        onEnd(error) {
          const shouldNotify = opened && !closing && input.signal?.aborted !== true;
          dead = error;
          livePid = undefined;
          const turn = current;
          current = undefined;
          externalPending.clear();
          if (turn !== undefined) turn.settled = true;
          loseEngineTurn(turn, () => ACP_CANCELLED, error);
          // The session is over: nothing follows the caller's signal any more.
          linked.abort();
          if (shouldNotify) invokeSafely(() => config.onDisconnect?.(error));
        },
      }),
      onProviderPid: recordPid,
      ...(input.onStartupPhase !== undefined && { onStartupPhase: input.onStartupPhase }),
    });
    if (livePid === undefined && !closing && dead === undefined) {
      recordPid((await connected.engine.pidReady) ?? connected.engine.pid);
    }
  } catch (error) {
    linked.release();
    throw error;
  }
  const { peer, initialized } = connected;
  const ensureAlive = () => {
    if (closing) throw new Error('The ACP session is closing');
    if (dead !== undefined) throw dead;
  };
  const stop = async (primary?: { error: unknown }) => {
    closing = true;
    livePid = undefined;
    drainExternalPending(externalPending);
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
    });
    const sessionId = openedSession.sessionId;
    configOptions = mergeInitialConfigOptions(
      configOptions,
      openedSession.configOptions,
      sawConfigOptionUpdate,
    );
    const desiredModel = input.model ?? config.model;
    const desiredThoughtLevel = input.thoughtLevel ?? config.thoughtLevel;
    const desiredMode = input.mode ?? config.mode;
    configOptions = await applySessionSelections({
      peer,
      sessionId,
      configOptions,
      models: openedSession.models,
      ...(desiredModel !== undefined && { model: desiredModel }),
      ...(desiredThoughtLevel !== undefined && { thoughtLevel: desiredThoughtLevel }),
      ...(desiredMode !== undefined && { mode: desiredMode }),
    });
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
      ensureAlive,
      getTurn: () => current,
      setTurn: (turn) => {
        current = turn;
      },
    });
    opened = true;
    return {
      nativeThreadId: sessionId,
      get providerPid() {
        return closing || dead !== undefined ? undefined : livePid;
      },
      approvalEnforcement: 'agent-initiated',
      get configOptions() {
        return configOptions;
      },
      get title() {
        return title;
      },
      get commands() {
        return commands;
      },
      async setConfigOption(configId, value) {
        ensureAlive();
        configOptions = await setOption(peer, sessionId, configOptions, configId, value);
        return configOptions;
      },
      async respond(interactionId, reply) {
        ensureAlive();
        answerAcpSessionRequest({ turn: current, externalPending, interactionId, reply });
      },
      ...turnControls,
      async close() {
        closing = true;
        drainExternalPending(externalPending);
        if (acpCan(connected, 'close'))
          await peer
            .request(
              'session/close',
              { sessionId },
              { timeoutMs: closeRequestTimeoutMs(config) },
            )
            .catch(() => undefined);
        await stop();
      },
    };
  } catch (error) {
    await stop({ error });
    throw error;
  }
}
