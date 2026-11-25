import type { AgentEngineSession, AgentEngineTurn } from '../engine';
import { holdEngineRequest, loseEngineTurn } from '../engine-requests';
import { DEFAULT_MAX_IMAGE_BYTES } from '../image-input';
import {
  JSON_RPC_METHOD_NOT_FOUND,
  JsonRpcError,
  type JsonRpcPeer,
  type JsonRpcValue,
} from '../json-rpc-peer';
import type { ExecutorProfileConfig } from '../profile';
import {
  nonEmptyString,
  offerTurnDelta,
  sessionAbort,
  stopConnection,
} from '../session-primitives';
import {
  type AcpDriverConfig,
  acpCan,
  assertAcpDriverOptions,
  closeRequestTimeoutMs,
  connectAcp,
} from './v1-connect';
import { acpPromptBlocks, mapAcpUpdate } from './v1-map';
import {
  type AcpConfigOption,
  AcpMcpServerSchema,
  AcpNewSessionResultSchema,
  AcpPermissionRequestSchema,
  AcpSessionStateSchema,
  AcpSetConfigOptionResultSchema,
  AcpUpdateNotificationSchema,
  acpOptionValues,
} from './v1-protocol';
import {
  ACP_CANCELLED,
  type AcpTurnSlot,
  acpTurnHandle,
  newAcpTurn,
  runAcpPrompt,
} from './v1-turn';

/**
 * How tool approvals are enforced over ACP: `'agent-initiated'` means the driver answers
 * `session/request_permission` requests when the agent sends them, but cannot compel an agent
 * to ask before running tools and never synthesizes fake requests after `tool_call` updates.
 */
export type AcpApprovalEnforcement = 'agent-initiated';

/** A session with what ACP says about it besides turns: its settings, title and commands. */
export interface AcpSession extends AgentEngineSession {
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

function createAcpHandlers(state: {
  getTurn: () => AcpTurnSlot | undefined;
  onSessionMeta: (meta: {
    configOptions?: readonly AcpConfigOption[];
    title?: string;
    commands?: readonly string[];
  }) => void;
  onEnd: (error: Error) => void;
}) {
  return {
    onNotification(method: string, params: unknown) {
      const turn = state.getTurn();
      if (method !== 'session/update') {
        if (turn !== undefined) {
          turn.chunk += 1;
          offerTurnDelta(turn.channel, {
            type: 'error',
            turnId: turn.state.turnId,
            itemId: `unhandled:${method}:${turn.chunk}`,
            raw: { source: 'acp', type: method },
            kind: 'unhandled',
            message: `ACP notification ${method} is not known to this driver`,
          });
        }
        return;
      }
      const parsed = AcpUpdateNotificationSchema.safeParse(params);
      if (!parsed.success) {
        if (turn !== undefined) {
          turn.chunk += 1;
          offerTurnDelta(turn.channel, {
            type: 'error',
            turnId: turn.state.turnId,
            itemId: `unhandled:session/update:${turn.chunk}`,
            raw: { source: 'acp', type: method },
            kind: 'unhandled',
            message: `ACP update did not match schema: ${parsed.error.message}`,
          });
        }
        return;
      }
      const { update } = parsed.data;
      state.onSessionMeta({
        ...(update.configOptions !== undefined && { configOptions: update.configOptions }),
        ...(update.sessionUpdate === 'session_info_update' &&
          typeof update.title === 'string' && { title: update.title }),
        ...(update.availableCommands !== undefined && {
          commands: update.availableCommands.map((command) => command.name),
        }),
      });
      if (turn === undefined) return;
      turn.chunk += 1;
      for (const delta of mapAcpUpdate(update, turn.state.turnId, turn.chunk, turn.track))
        offerTurnDelta(turn.channel, delta);
    },
    onRequest(method: string, params: unknown, id: string | number) {
      const turn = state.getTurn();
      if (method !== 'session/request_permission' || turn === undefined) {
        if (turn !== undefined) {
          offerTurnDelta(turn.channel, {
            type: 'error',
            turnId: turn.state.turnId,
            itemId: `unhandled-request:${id}`,
            raw: { source: 'acp', type: method },
            kind: 'unhandled',
            message: `ACP request ${method} is not known to this driver; refused`,
          });
        }
        throw new JsonRpcError(
          JSON_RPC_METHOD_NOT_FOUND,
          `${method} is not handled by this executor`,
        );
      }
      const asked = AcpPermissionRequestSchema.parse(params);
      const interactionId = String(id);
      const toolInput = asked.toolCall.rawInput ?? asked.toolCall.args;
      const callId = nonEmptyString(asked.toolCall.toolCallId);
      const toolName =
        nonEmptyString(asked.toolCall.name) ?? nonEmptyString(asked.toolCall.title) ?? 'tool';
      return new Promise<JsonRpcValue>((resolve) => {
        holdEngineRequest(turn, {
          interactionId,
          detail: { options: asked.options },
          answeredBy: { source: 'acp', type: 'session/request_permission' },
          delta: () => ({
            type: 'request',
            turnId: turn.state.turnId,
            itemId: `request:${interactionId}`,
            raw: { source: 'acp', type: method },
            interactionId,
            kind: 'approval',
            ...(callId !== undefined && { callId }),
            toolName,
            ...(toolInput !== undefined && { input: toolInput }),
          }),
          refusal: ACP_CANCELLED,
          resolve,
        });
      });
    },
    onEnd: state.onEnd,
  };
}

export async function openAcpSession(
  config: AcpDriverConfig,
  input: {
    profile: ExecutorProfileConfig;
    cwd: string;
    nativeThreadId?: string;
    signal?: AbortSignal;
  },
): Promise<AcpSession> {
  assertAcpDriverOptions(config);
  const mcpServers = (config.mcpServers ?? []).map((server) =>
    AcpMcpServerSchema.parse(server),
  );
  const linked = sessionAbort(input.signal);
  let current: AcpTurnSlot | undefined;
  let turnOpening = false;
  let closing = false;
  let dead: Error | undefined;
  let configOptions: readonly AcpConfigOption[] = [];
  let title: string | undefined;
  let commands: readonly string[] = [];
  let connected: Awaited<ReturnType<typeof connectAcp>>;
  try {
    connected = await connectAcp(
      config,
      input.profile,
      input.cwd,
      linked.signal,
      createAcpHandlers({
        getTurn: () => current,
        onSessionMeta(meta) {
          if (meta.configOptions !== undefined) configOptions = meta.configOptions;
          if (meta.title !== undefined) title = meta.title;
          if (meta.commands !== undefined) commands = meta.commands;
        },
        onEnd(error) {
          dead = error;
          const turn = current;
          current = undefined;
          loseEngineTurn(turn, () => ACP_CANCELLED, error);
          // The session is over: nothing follows the caller's signal any more.
          linked.abort();
        },
      }),
    );
  } catch (error) {
    linked.release();
    throw error;
  }
  const { peer, initialized } = connected;
  const stop = async (primary?: { error: unknown }) => {
    linked.abort();
    await stopConnection(connected, primary);
  };
  try {
    let sessionId: string;
    if (input.nativeThreadId === undefined) {
      const created = AcpNewSessionResultSchema.parse(
        await peer.request('session/new', { cwd: input.cwd, mcpServers }),
      );
      sessionId = created.sessionId;
      configOptions = created.configOptions ?? configOptions;
    } else {
      // `resume` reopens without replaying the history; `load` replays it.
      const method = acpCan(connected, 'resume') ? 'session/resume' : 'session/load';
      const reopened = AcpSessionStateSchema.parse(
        (await peer.request(method, {
          sessionId: input.nativeThreadId,
          cwd: input.cwd,
          mcpServers,
        })) ?? {},
      );
      sessionId = input.nativeThreadId;
      configOptions = reopened.configOptions ?? configOptions;
    }
    for (const [category, value] of [
      ['model', config.model],
      ['thought_level', config.thoughtLevel],
      ['mode', config.mode],
    ] as const) {
      if (value !== undefined)
        configOptions = await setOption(peer, sessionId, configOptions, category, value);
    }
    const limits = {
      images: initialized.agentCapabilities?.promptCapabilities?.image === true,
      maxImageBytes: config.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES,
      ...(config.resolveFile && { resolveFile: config.resolveFile }),
    };
    return {
      nativeThreadId: sessionId,
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
        if (closing) throw new Error('The ACP session is closing');
        if (dead !== undefined) throw dead;
        configOptions = await setOption(peer, sessionId, configOptions, configId, value);
        return configOptions;
      },
      async startTurn(turnInput): Promise<AgentEngineTurn> {
        if (closing) throw new Error('The ACP session is closing');
        if (dead !== undefined) throw dead;
        if (current !== undefined || turnOpening)
          throw new Error('A turn is already running in this ACP session');
        turnOpening = true;
        let prompt: readonly { type: string; [key: string]: string }[];
        try {
          prompt = await acpPromptBlocks(turnInput.input, limits);
        } finally {
          turnOpening = false;
        }
        if (closing) throw new Error('The ACP session is closing');
        if (dead !== undefined) throw dead;
        const turn = newAcpTurn(turnInput.turnId);
        current = turn;
        runAcpPrompt(peer, sessionId, prompt, turn, () => {
          if (current === turn) current = undefined;
        });
        return acpTurnHandle(peer, sessionId, turn);
      },
      async close() {
        closing = true;
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
