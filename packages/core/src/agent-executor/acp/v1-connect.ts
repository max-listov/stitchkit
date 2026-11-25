import { assertTimerMs } from '../../internal/deadline';
import { assertPositiveSafeInteger } from '../../internal/positive-integer';
import { NativeCommandError } from '../../process/contract';
import { spawnEngineProcess } from '../engine-process';
import { createJsonRpcPeer, type JsonRpcPeer } from '../json-rpc-peer';
import { type ExecutorProfileConfig, engineEnvironment } from '../profile';
import { stopConnection } from '../session-primitives';
import type { AcpMcpServer } from './v1-protocol';
import { ACP_PROTOCOL_VERSION, AcpInitializeResultSchema } from './v1-protocol';

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const CLOSE_REQUEST_TIMEOUT_MS = 5_000;

/** Configuration for {@link createAcpDriver}. */
export interface AcpDriverConfig {
  /** The agent to run: `agy`, `gemini`. */
  executable: string;
  /** Its arguments: `['acp']`, `['acp', '--sandbox']`, `['--experimental-acp']`. */
  args?: readonly string[];
  /** Set at open through the option of category `model`; refused if the agent offers none or not this value. */
  model?: string;
  /** Set at open through the option of category `thought_level`, after the model, which may narrow it. */
  thoughtLevel?: string;
  /**
   * Set at open through the option of category `mode`. Negotiates the agent's advertised mode
   * value only; it does not enforce host-side pre-execution tool approval (`approvalEnforcement`
   * is `'agent-initiated'`). Whether an agent sends `session/request_permission` before a tool
   * runs depends on the agent's own permission policy (for example, `agy` requires an isolated
   * `--cli_dir_name <subdir>` with `{"toolPermission":"strict","agentMode":""}` in
   * `~/.gemini/antigravity-cli/<subdir>/settings.json`, which prompts before every tool action
   * including reads).
   */
  mode?: string;
  /** MCP servers the agent connects to, passed on `session/new`, `session/load` and `session/resume`. */
  mcpServers?: readonly AcpMcpServer[];
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

/** Bounded timeout for `session/close`: capped at 5 s and never longer than `requestTimeoutMs`. */
export function closeRequestTimeoutMs(
  config: Pick<AcpDriverConfig, 'requestTimeoutMs'>,
): number {
  return Math.min(
    config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    CLOSE_REQUEST_TIMEOUT_MS,
  );
}

/** Refuse a numeric option out of range, before any agent is spawned. */
export function assertAcpDriverOptions(config: AcpDriverConfig): void {
  assertTimerMs('requestTimeoutMs', config.requestTimeoutMs);
  assertPositiveSafeInteger('maxFrameBytes', config.maxFrameBytes);
  assertPositiveSafeInteger('maxImageBytes', config.maxImageBytes);
}

export type AcpHandlers = {
  onRequest?: Parameters<typeof createJsonRpcPeer>[0]['onRequest'];
  onNotification?: Parameters<typeof createJsonRpcPeer>[0]['onNotification'];
  onEnd?: (error: Error) => void;
};

/** Spawn the agent and agree on protocol 1; another version is refused and the agent stopped. */
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
      for await (const line of engine.lines) peer.receive(line);
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
    const initialized = AcpInitializeResultSchema.parse(
      await peer.request('initialize', {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      }),
    );
    if (initialized.protocolVersion !== ACP_PROTOCOL_VERSION) {
      throw new Error(
        `The ACP agent speaks protocol ${initialized.protocolVersion}; this driver speaks ${ACP_PROTOCOL_VERSION}`,
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

/** Whether the agent declared a session capability (`resume`, `list`): `{}` or `true`. */
export function acpCan(
  connection: AcpConnection,
  capability: 'resume' | 'load' | 'list' | 'close',
): boolean {
  const value = connection.initialized.agentCapabilities?.sessionCapabilities?.[capability];
  return value !== undefined && value !== false;
}
