import { z } from 'zod';
import { assertTimerMs } from '../../internal/deadline';
import { assertPositiveSafeInteger } from '../../internal/positive-integer';
import { NativeCommandError } from '../../process/contract';
import { spawnEngineProcess } from '../engine-process';
import { createJsonRpcPeer, type JsonRpcPeer, type JsonRpcValue } from '../json-rpc-peer';
import { type ExecutorProfileConfig, engineEnvironment } from '../profile';
import { emitStartupPhase, safeJsonValue, stopConnection } from '../session-primitives';
import type {
  ExecutorErrorKind,
  ExecutorStartupPhase,
  ExecutorThreadDisposition,
} from '../vocabulary';
import type {
  AcpPermissionRequestEvent,
  AcpTransformUpdate,
  AcpUpdateEvent,
} from './v1-handlers';
import {
  ACP_PROTOCOL_VERSION,
  type AcpClientInfo,
  AcpClientInfoSchema,
  type AcpInitializeResult,
  AcpInitializeResultSchema,
  type AcpMcpServer,
  type AcpPromptResult,
} from './v1-protocol';

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const CLOSE_REQUEST_TIMEOUT_MS = 5_000;
const MAX_PASSIVE_VERSION_LENGTH = 256;
const SessionMetaRecordSchema = z.record(z.string(), z.json());

/** How `info()` and `status()` probe the ACP agent. */
export type AcpProbeMode = 'ephemeral-session' | 'initialize-only' | 'passive';

/** How {@link AcpSession.steerTurn} steers a running turn. */
export type AcpSteerMode = 'none' | 'prompt';

/** Optional `_meta` object passed on `session/new`, `session/resume`, and `session/load`. */
export type AcpSessionMetaInput =
  | Readonly<Record<string, JsonRpcValue>>
  | ((initialized: AcpInitializeResult) => Readonly<Record<string, JsonRpcValue>> | undefined);

/** Structured failure override returned by {@link AcpWatchPromptOutcome} to reclassify a prompt response. */
export interface AcpPromptOutcomeOverride {
  readonly outcome?: 'failed';
  readonly errorKind: ExecutorErrorKind;
  readonly message: string;
  readonly threadDisposition?: ExecutorThreadDisposition;
}

/**
 * Optional hook run before each `session/prompt` request; returns a checker invoked once the
 * prompt settles so host-side inspection can detect failures masked behind `stopReason: "end_turn"`.
 */
export type AcpWatchPromptOutcome = (context: {
  readonly sessionId: string;
  readonly turnId: string;
  readonly generation: number;
}) =>
  | Promise<
      (
        result: AcpPromptResult,
      ) => Promise<AcpPromptOutcomeOverride | undefined> | AcpPromptOutcomeOverride | undefined
    >
  | ((
      result: AcpPromptResult,
    ) => Promise<AcpPromptOutcomeOverride | undefined> | AcpPromptOutcomeOverride | undefined);

/** Configuration for {@link createAcpDriver}. */
export interface AcpDriverConfig {
  /** The agent to run: `agy`, `gemini`. */
  executable: string;
  /** Its arguments: `['acp']`, `['acp', '--sandbox']`, `['--experimental-acp']`. */
  args?: readonly string[];
  /** Optional `clientInfo` sent on `initialize`. */
  clientInfo?: AcpClientInfo;
  /** Optional `_meta` object (or factory over the `initialize` response) sent on session open/resume/load. */
  sessionMeta?: AcpSessionMetaInput;
  /**
   * Optional filter invoked on every stdout line before JSON-RPC parsing; returning `false`
   * skips non-protocol lines (such as OAuth prompts) instead of failing the connection.
   */
  stdoutLineFilter?: (line: string) => boolean;
  /**
   * How `info()` and `status()` probe the agent: `'ephemeral-session'` (default, runs `initialize`
   * and an ephemeral `session/new`), `'initialize-only'` (skips `session/new`), or `'passive'`
   * (spawns zero processes and reports honest `unknown`/`not-asked`).
   */
  probeMode?: AcpProbeMode;
  /** Version reported by `info()` when `probeMode` is `'passive'` (defaults to `'unknown'`). */
  passiveVersion?: string;
  /** Set at open through the option of category `model`; refused if the agent offers none or not this value. */
  model?: string;
  /** Set at open through the option of category `thought_level`, after the model, which may narrow it. */
  thoughtLevel?: string;
  /**
   * Set at open through the option of category `mode`. Negotiates the agent's advertised mode
   * value only; it does not enforce host-side pre-execution tool approval (`approvalEnforcement`
   * is `'agent-initiated'`). Whether an agent sends `session/request_permission` before a tool
   * runs depends on the agent's own permission policy.
   */
  mode?: string;
  /** MCP servers the agent connects to, passed on `session/new`, `session/load` and `session/resume`. */
  mcpServers?: readonly AcpMcpServer[];
  /** Optional transformer normalizing, expanding, or dropping incoming `session/update` records before mapping. */
  transformUpdate?: AcpTransformUpdate;
  /** Optional observer invoked for `session/update` notifications on an open session (including post-settle). */
  onUpdate?: (event: AcpUpdateEvent) => void;
  /**
   * Optional handler for `session/request_permission` arriving outside an active `startTurn()`.
   * When omitted, requests outside an active turn are refused with `-32601`.
   */
  onPermissionRequest?: (event: AcpPermissionRequestEvent) => Promise<void> | void;
  /** Optional callback invoked when an opened session drops unexpectedly before `close()` or caller abort. */
  onDisconnect?: (error: Error) => void;
  /**
   * Optional hook started before `session/prompt` and consulted after it settles so hidden API
   * errors masked as `end_turn` can fail the turn with an error kind and `threadDisposition`.
   */
  watchPromptOutcome?: AcpWatchPromptOutcome;
  /**
   * Whether the agent's `usage.inputTokens` already includes `cachedReadTokens`. Default `true`.
   * Set `false` for agents that report uncached input separately so `cachedReadTokens` is added.
   */
  usageInputIncludesCachedRead?: boolean;
  /** Whether `session.steerTurn()` is disabled (`'none'`, default) or steers via a new `session/prompt` (`'prompt'`). */
  steerMode?: AcpSteerMode;
  /** The bytes behind a `file` part's `reference`; without it a file part is refused. */
  resolveFile?: (reference: string) => Promise<Uint8Array>;
  /** The largest image sent. Default 5 MiB. */
  maxImageBytes?: number;
  /** The longest line the agent may write — a replayed image is one line. Default 8 MiB. */
  maxFrameBytes?: number;
  ambient?: Readonly<Record<string, string | undefined>>;
  /** How long one request (`initialize`, `session/new`) may take. Default 60 s. */
  requestTimeoutMs?: number;
}

/** Bounded timeout for `session/close` and `session/delete`: capped at 5 s and never longer than `requestTimeoutMs`. */
export function closeRequestTimeoutMs(
  config: Pick<AcpDriverConfig, 'requestTimeoutMs'>,
): number {
  return Math.min(
    config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    CLOSE_REQUEST_TIMEOUT_MS,
  );
}

function validateSessionMetaObject(meta: unknown): Record<string, JsonRpcValue> {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
    throw new TypeError('sessionMeta must be a plain JSON object');
  }
  return SessionMetaRecordSchema.parse(safeJsonValue(meta));
}

/** Resolve and validate optional `_meta` for `session/new`, `session/resume`, or `session/load`. */
export function resolveAcpSessionMeta(
  sessionMeta: AcpSessionMetaInput | undefined,
  initialized: AcpInitializeResult,
): Record<string, JsonRpcValue> | undefined {
  if (sessionMeta === undefined) return undefined;
  const resolved = typeof sessionMeta === 'function' ? sessionMeta(initialized) : sessionMeta;
  if (resolved === undefined) return undefined;
  return validateSessionMetaObject(resolved);
}

/** Refuse invalid options before any agent is spawned. */
export function assertAcpDriverOptions(config: AcpDriverConfig): void {
  assertTimerMs('requestTimeoutMs', config.requestTimeoutMs);
  assertPositiveSafeInteger('maxFrameBytes', config.maxFrameBytes);
  assertPositiveSafeInteger('maxImageBytes', config.maxImageBytes);
  if (
    config.probeMode !== undefined &&
    config.probeMode !== 'ephemeral-session' &&
    config.probeMode !== 'initialize-only' &&
    config.probeMode !== 'passive'
  ) {
    throw new TypeError(`Invalid probeMode ${JSON.stringify(config.probeMode)}`);
  }
  if (config.passiveVersion !== undefined) {
    const trimmed = config.passiveVersion.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_PASSIVE_VERSION_LENGTH) {
      throw new TypeError(
        `passiveVersion must be a non-empty string up to ${MAX_PASSIVE_VERSION_LENGTH} characters`,
      );
    }
  }
  if (
    config.steerMode !== undefined &&
    config.steerMode !== 'none' &&
    config.steerMode !== 'prompt'
  ) {
    throw new TypeError(`Invalid steerMode ${JSON.stringify(config.steerMode)}`);
  }
  if (config.clientInfo !== undefined) {
    AcpClientInfoSchema.parse(config.clientInfo);
  }
  if (config.sessionMeta !== undefined && typeof config.sessionMeta !== 'function') {
    validateSessionMetaObject(config.sessionMeta);
  }
}

export type AcpHandlers = {
  onRequest?: Parameters<typeof createJsonRpcPeer>[0]['onRequest'];
  onNotification?: Parameters<typeof createJsonRpcPeer>[0]['onNotification'];
  onEnd?: (error: Error) => void;
  onStartupPhase?: (phase: ExecutorStartupPhase) => void;
};

/** Spawn the agent and perform the ACP v1 handshake; ACP v2 (`"info" in raw`) or version < 1 is refused. */
export async function connectAcp(
  config: AcpDriverConfig,
  profile: ExecutorProfileConfig,
  cwd: string,
  signal: AbortSignal,
  handlers: AcpHandlers = {},
) {
  assertAcpDriverOptions(config);
  // Everything that can refuse runs before the spawn: nothing after it leaves the agent running.
  const env = engineEnvironment(profile, config.ambient ?? process.env);
  const peer: JsonRpcPeer = createJsonRpcPeer({
    header: 'jsonrpc-2.0',
    requestTimeoutMs: config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    send: (line) => engine.send(line),
    ...(handlers.onRequest && { onRequest: handlers.onRequest }),
    ...(handlers.onNotification && { onNotification: handlers.onNotification }),
  });
  emitStartupPhase(handlers.onStartupPhase, 'spawning');
  const engine = spawnEngineProcess({
    executable: config.executable,
    args: [...(config.args ?? [])],
    cwd,
    env,
    signal,
    ...(config.maxFrameBytes !== undefined && { maxLineBytes: config.maxFrameBytes }),
  });
  const reading = (async () => {
    try {
      for await (const line of engine.lines) {
        if (config.stdoutLineFilter !== undefined && !config.stdoutLineFilter(line)) {
          continue;
        }
        peer.receive(line);
      }
      const ended = new Error(
        `The ACP agent ${config.executable} exited: ${engine.stderrTail().slice(-2000)}`,
      );
      peer.close(ended);
      handlers.onEnd?.(ended);
    } catch (error) {
      // Only a missing/unlaunchable executable is wrapped; protocol/parse/frame errors stay typed.
      const failed =
        error instanceof NativeCommandError && error.code === 'COMMAND_UNAVAILABLE'
          ? new Error(`The ACP agent ${config.executable} could not run: ${error.message}`, {
              cause: error,
            })
          : error instanceof Error
            ? error
            : new Error(String(error), { cause: error });
      peer.close(failed);
      handlers.onEnd?.(failed);
      await engine.stop().catch(() => undefined);
    }
  })();
  try {
    emitStartupPhase(handlers.onStartupPhase, 'initializing');
    const clientInfo =
      config.clientInfo !== undefined
        ? AcpClientInfoSchema.parse(config.clientInfo)
        : undefined;
    const rawInitialized = await peer.request('initialize', {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      ...(clientInfo !== undefined && { clientInfo }),
    });
    if (
      typeof rawInitialized === 'object' &&
      rawInitialized !== null &&
      !Array.isArray(rawInitialized) &&
      'info' in rawInitialized
    ) {
      throw new Error(
        `The ACP agent speaks protocol v2 (initialize response has "info"); this driver speaks ACP v${ACP_PROTOCOL_VERSION}`,
      );
    }
    const initialized = AcpInitializeResultSchema.parse(rawInitialized);
    if (initialized.protocolVersion < ACP_PROTOCOL_VERSION) {
      throw new Error(
        `The ACP agent speaks protocol ${initialized.protocolVersion}; this driver requires protocol >= ${ACP_PROTOCOL_VERSION}`,
      );
    }
    return { engine, peer, reading, initialized };
  } catch (error) {
    // The reader closes the peer once the stopped process's output ends.
    await stopConnection({ engine, reading }, { error });
    throw error;
  }
}

export type AcpConnection = Awaited<ReturnType<typeof connectAcp>>;

/** Whether the agent declared a session capability (`resume`, `load`, `list`, `close`, `delete`): `{}` or `true`. */
export function acpCan(
  connection: AcpConnection,
  capability: 'resume' | 'load' | 'list' | 'close' | 'delete',
): boolean {
  const value = connection.initialized.agentCapabilities?.sessionCapabilities?.[capability];
  return value !== undefined && value !== null && value !== false;
}
