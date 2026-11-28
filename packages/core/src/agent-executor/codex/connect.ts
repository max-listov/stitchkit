import { abortReason, raceAbort } from '../../internal/abort-race';
import { assertTimerMs, withSignalDeadline } from '../../internal/deadline';
import { assertExpectedOwnerUid } from '../../internal/unix-socket';
import {
  type EngineProcess,
  type EngineProcessWrapCommand,
  resolveWrappedEngineCommand,
  spawnEngineProcess,
} from '../engine-process';
import { createJsonRpcPeer, type JsonRpcPeer } from '../json-rpc-peer';
import { type ExecutorProfileConfig, engineEnvironment } from '../profile';
import {
  type EngineConnection,
  emitStartupPhase,
  nonEmptyString,
  type ObserverErrorHandler,
  stopConnection,
} from '../session-primitives';
import type { ExecutorStartupPhase } from '../vocabulary';
import { CODEX_OPTED_OUT_NOTIFICATIONS } from './notifications';
import { CodexInitializeResponseSchema, parseCodexResponse } from './protocol';
import {
  type CodexUnixSocketClient,
  CodexUnixSocketError,
  connectCodexUnixSocket,
  validateCodexUnixSocketPath,
} from './unix-socket';
import { assertCodexUnixListenTargetAvailable } from './unix-socket-target';

/** How long the app-server may take to initialize and open its thread. */
const BOOTSTRAP_MS = 45_000;
const REQUEST_MS = 60_000;
const DEFAULT_LISTEN_TIMEOUT_MS = 15_000;
const POLL_INITIAL_MS = 15;
const POLL_MAX_MS = 50;

/** Transport mode used by {@link createCodexDriver} to reach `codex app-server`. */
export type CodexTransportConfig =
  | { readonly kind: 'stdio' }
  | {
      readonly kind: 'unix-listen';
      /** Absolute Unix domain socket path where the spawned `codex app-server` will listen (`--listen unix://<path>`). */
      readonly socketPath: string;
      /** Maximum time in milliseconds to wait for the spawned server to begin listening. Default 15 000 ms. */
      readonly listenTimeoutMs?: number | undefined;
    }
  | {
      readonly kind: 'unix-connect';
      /** Absolute Unix domain socket path of an already-running `codex app-server`. */
      readonly socketPath: string;
      /** Expected POSIX UID owning the socket and its directory. Defaults to `process.getuid()`. */
      readonly expectedOwnerUid?: number | undefined;
    };

/** Whether other clients can reach the same app-server: any Unix-socket transport, where a TUI may attach. */
export function codexTransportShared(config: {
  readonly transport?: CodexTransportConfig | undefined;
}): boolean {
  return config.transport !== undefined && config.transport.kind !== 'stdio';
}

/** Connection inputs needed to spawn or dial a Codex app-server. */
export interface CodexConnectConfig {
  readonly executable: string;
  readonly prefix: readonly string[];
  readonly transport?: CodexTransportConfig | undefined;
  readonly serverArgs?: readonly string[] | undefined;
  readonly ambient: Readonly<Record<string, string | undefined>>;
  readonly wrapCommand?: EngineProcessWrapCommand | undefined;
  readonly version: string;
  readonly maxFrameBytes?: number | undefined;
  readonly onObserverError?: ObserverErrorHandler | undefined;
}

/** Active JSON-RPC connection to a Codex app-server (stdio or Unix socket). */
export interface CodexConnection extends EngineConnection {
  readonly peer: JsonRpcPeer;
  /** OS process id of the spawned `codex app-server`, or `undefined` in `unix-connect` mode. */
  readonly providerPid: number | undefined;
  /** Server-reported `userAgent` from the `initialize` response, or `undefined` when omitted. */
  readonly userAgent: string | undefined;
}

type PeerHandlers = Partial<
  Pick<Parameters<typeof createJsonRpcPeer>[0], 'onRequest' | 'onNotification'>
>;

/** Eagerly validate `transport` and `serverArgs` before creating a Codex driver. */
export function validateCodexTransportAndArgs(config: {
  readonly transport?: CodexTransportConfig | undefined;
  readonly serverArgs?: readonly string[] | undefined;
}): void {
  if (config.serverArgs !== undefined) {
    if (!Array.isArray(config.serverArgs)) {
      throw new TypeError(
        '[stitchkit] createCodexDriver: serverArgs must be an array of strings',
      );
    }
    for (const arg of config.serverArgs) {
      if (typeof arg !== 'string') {
        throw new TypeError(
          '[stitchkit] createCodexDriver: every serverArgs entry must be a string',
        );
      }
      if (
        arg === '--listen' ||
        arg === '--stdio' ||
        arg.startsWith('--listen=') ||
        arg.startsWith('--stdio=')
      ) {
        throw new TypeError(
          `[stitchkit] createCodexDriver: serverArgs must not include "${arg}"; configure transport via config.transport instead`,
        );
      }
    }
  }
  const transport = config.transport;
  if (transport === undefined || transport.kind === 'stdio') return;
  if (transport.kind === 'unix-listen') {
    validateCodexUnixSocketPath(transport.socketPath, 'createCodexDriver');
    assertTimerMs('listenTimeoutMs', transport.listenTimeoutMs);
    return;
  }
  if (transport.kind === 'unix-connect') {
    validateCodexUnixSocketPath(transport.socketPath, 'createCodexDriver');
    assertExpectedOwnerUid(transport.expectedOwnerUid, 'createCodexDriver');
    if ((config.serverArgs?.length ?? 0) > 0) {
      throw new TypeError(
        '[stitchkit] createCodexDriver: serverArgs cannot be used with transport kind "unix-connect"',
      );
    }
    return;
  }
  throw new TypeError(
    `[stitchkit] createCodexDriver: unsupported transport kind ${JSON.stringify(Reflect.get(Object(transport), 'kind'))}`,
  );
}

async function initializeCodexPeer(
  peer: JsonRpcPeer,
  version: string,
): Promise<string | undefined> {
  const reply = await peer.request(
    'initialize',
    {
      clientInfo: { name: 'stitchkit-agent-executor', version },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: CODEX_OPTED_OUT_NOTIFICATIONS,
      },
    },
    { timeoutMs: BOOTSTRAP_MS },
  );
  const parsed = parseCodexResponse('initialize', CodexInitializeResponseSchema, reply);
  peer.notify('initialized');
  return nonEmptyString(parsed.userAgent);
}

function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function dialWithEngineRace(input: {
  socketPath: string;
  listenTimeoutMs: number;
  maxFrameBytes?: number;
  signal: AbortSignal;
  engine: EngineProcess;
  onMessage(text: string): void;
  onClose(error: Error): void;
}): Promise<CodexUnixSocketClient> {
  const exitAbort = new AbortController();
  let exitedEarly: Error | undefined;
  void input.engine.result.then(
    (res) => {
      const detail = input.engine.stderrTail().slice(-2000).trim();
      exitedEarly = new Error(
        `Codex app-server exited before listening on "${input.socketPath}" (code ${res.exitCode ?? 'signal'})${detail.length > 0 ? `: ${detail}` : ''}`,
      );
      exitAbort.abort(exitedEarly);
    },
    (error: unknown) => {
      const detail = input.engine.stderrTail().slice(-2000).trim();
      exitedEarly = new Error(
        `Codex app-server failed before listening on "${input.socketPath}": ${error instanceof Error ? error.message : String(error)}${detail.length > 0 ? ` (${detail})` : ''}`,
        { cause: error },
      );
      exitAbort.abort(exitedEarly);
    },
  );

  return withSignalDeadline(
    input.listenTimeoutMs,
    input.signal,
    () =>
      new CodexUnixSocketError(
        'endpoint-absent',
        input.socketPath,
        `Codex app-server did not listen on "${input.socketPath}" within ${input.listenTimeoutMs} ms`,
      ),
    async (deadlineSignal) => {
      let delayMs = POLL_INITIAL_MS;
      for (;;) {
        if (exitedEarly !== undefined) throw exitedEarly;
        deadlineSignal.throwIfAborted();
        try {
          return await raceAbort(
            connectCodexUnixSocket({
              socketPath: input.socketPath,
              // Long-lived connection follows the session signal; only connect/upgrade uses deadlineSignal.
              signal: input.signal,
              connectSignal: deadlineSignal,
              ...(input.maxFrameBytes !== undefined && { maxFrameBytes: input.maxFrameBytes }),
              onMessage: input.onMessage,
              onClose: input.onClose,
            }),
            exitAbort.signal,
            (lateClient) => {
              void lateClient.close().catch(() => undefined);
            },
          );
        } catch (error) {
          if (exitedEarly !== undefined) throw exitedEarly;
          const retryable =
            error instanceof CodexUnixSocketError &&
            (error.kind === 'endpoint-absent' || error.kind === 'endpoint-not-listening');
          if (!retryable) throw error;
          await raceAbort(sleepAbortable(delayMs, deadlineSignal), exitAbort.signal);
          delayMs = Math.min(POLL_MAX_MS, Math.round(delayMs * 1.5));
        }
      }
    },
  );
}

async function connectCodexStdio(
  config: CodexConnectConfig,
  profile: ExecutorProfileConfig,
  cwd: string,
  extraArgs: readonly string[],
  signal: AbortSignal,
  handlers: PeerHandlers,
  onEnd: (error: Error) => void,
  onStartupPhase?: (phase: ExecutorStartupPhase) => void,
): Promise<CodexConnection> {
  const env = engineEnvironment(profile, config.ambient);
  const command = await resolveWrappedEngineCommand(
    {
      executable: config.executable,
      args: [...config.prefix, 'app-server', ...extraArgs],
      cwd,
      env,
    },
    config.wrapCommand,
    'createCodexDriver',
    signal,
  );
  let endedError: Error | undefined;
  let ready = false;
  const peer = createJsonRpcPeer({
    header: 'omitted',
    requestTimeoutMs: REQUEST_MS,
    send: (line) => engine.send(line),
    ...handlers,
  });
  const finishEnd = (error: Error) => {
    if (endedError !== undefined) return;
    endedError = error;
    peer.close(error);
    if (ready) onEnd(error);
  };
  emitStartupPhase(onStartupPhase, 'spawning', config.onObserverError);
  const engine = spawnEngineProcess({
    executable: command.executable,
    args: command.args,
    cwd: command.cwd,
    env: command.env,
    signal,
    ...(config.maxFrameBytes !== undefined && { maxLineBytes: config.maxFrameBytes }),
  });
  const reading = (async () => {
    try {
      for await (const line of engine.lines) peer.receive(line);
      finishEnd(new Error(`Codex app-server exited: ${engine.stderrTail().slice(-2000)}`));
    } catch (error) {
      const failed = error instanceof Error ? error : new Error(String(error));
      finishEnd(failed);
      await engine.stop().catch(() => undefined);
    }
  })();
  try {
    emitStartupPhase(onStartupPhase, 'initializing', config.onObserverError);
    const userAgent = await initializeCodexPeer(peer, config.version);
    const providerPid = (await engine.pidReady) ?? engine.pid;
    if (endedError !== undefined) throw endedError;
    ready = true;
    return { engine, peer, reading, providerPid, userAgent };
  } catch (error) {
    await stopConnection({ engine, reading }, { error });
    throw error;
  }
}

/** Connect to a Codex app-server over stdio, a spawned Unix socket, or an existing Unix socket. */
export async function connectCodex(
  config: CodexConnectConfig,
  profile: ExecutorProfileConfig,
  cwd: string,
  signal: AbortSignal,
  handlers: PeerHandlers = {},
  onEnd: (error: Error) => void = () => undefined,
  onStartupPhase?: (phase: ExecutorStartupPhase) => void,
): Promise<CodexConnection> {
  const transport = config.transport ?? { kind: 'stdio' as const };
  const extraArgs = config.serverArgs ?? [];

  if (transport.kind === 'stdio') {
    return connectCodexStdio(
      config,
      profile,
      cwd,
      extraArgs,
      signal,
      handlers,
      onEnd,
      onStartupPhase,
    );
  }

  let wsClient: CodexUnixSocketClient | undefined;
  let spawnedEngine: EngineProcess | undefined;
  let endedError: Error | undefined;
  let ready = false;
  // Create the JSON-RPC peer before dialing so pipelined/trailing frames after HTTP 101 are never lost.
  const peer = createJsonRpcPeer({
    header: 'omitted',
    requestTimeoutMs: REQUEST_MS,
    send: (line) => {
      if (wsClient === undefined) {
        throw new Error('Codex Unix socket transport is not connected');
      }
      wsClient.send(line);
    },
    ...handlers,
  });
  const finishEnd = (error: Error) => {
    if (endedError !== undefined) return;
    endedError = error;
    peer.close(error);
    if (ready) onEnd(error);
  };
  const onMessage = (line: string) => {
    try {
      peer.receive(line);
    } catch (error) {
      const failed = error instanceof Error ? error : new Error(String(error));
      finishEnd(failed);
      void wsClient?.close().catch(() => undefined);
      void spawnedEngine?.stop().catch(() => undefined);
    }
  };
  const onClose = (error: Error) => {
    finishEnd(error);
  };

  if (transport.kind === 'unix-listen') {
    assertCodexUnixListenTargetAvailable(transport.socketPath, 'createCodexDriver');
    const env = engineEnvironment(profile, config.ambient);
    let command: Awaited<ReturnType<typeof resolveWrappedEngineCommand>>;
    try {
      command = await resolveWrappedEngineCommand(
        {
          executable: config.executable,
          args: [
            ...config.prefix,
            'app-server',
            '--listen',
            `unix://${transport.socketPath}`,
            ...extraArgs,
          ],
          cwd,
          env,
        },
        config.wrapCommand,
        'createCodexDriver',
        signal,
      );
    } catch (error) {
      peer.close(error);
      throw error;
    }
    emitStartupPhase(onStartupPhase, 'spawning', config.onObserverError);
    spawnedEngine = spawnEngineProcess({
      executable: command.executable,
      args: command.args,
      cwd: command.cwd,
      env: command.env,
      signal,
      stdoutMode: 'drain',
      ...(config.maxFrameBytes !== undefined && { maxLineBytes: config.maxFrameBytes }),
    });
    try {
      wsClient = await dialWithEngineRace({
        socketPath: transport.socketPath,
        listenTimeoutMs: transport.listenTimeoutMs ?? DEFAULT_LISTEN_TIMEOUT_MS,
        ...(config.maxFrameBytes !== undefined && { maxFrameBytes: config.maxFrameBytes }),
        signal,
        engine: spawnedEngine,
        onMessage,
        onClose,
      });
    } catch (error) {
      peer.close(error);
      await spawnedEngine.stop().catch(() => undefined);
      throw error;
    }
  } else {
    try {
      wsClient = await connectCodexUnixSocket({
        socketPath: transport.socketPath,
        ...(transport.expectedOwnerUid !== undefined && {
          expectedOwnerUid: transport.expectedOwnerUid,
        }),
        signal,
        ...(config.maxFrameBytes !== undefined && { maxFrameBytes: config.maxFrameBytes }),
        onMessage,
        onClose,
      });
    } catch (error) {
      peer.close(error);
      throw error;
    }
  }

  const activeWs = wsClient;
  const compositeEngine = {
    async stop() {
      try {
        await activeWs.close();
      } finally {
        if (spawnedEngine !== undefined) await spawnedEngine.stop();
      }
    },
  };
  const reading = activeWs.closed;
  try {
    if (endedError !== undefined) throw endedError;
    emitStartupPhase(onStartupPhase, 'initializing', config.onObserverError);
    const userAgent = await initializeCodexPeer(peer, config.version);
    if (endedError !== undefined) throw endedError;
    const providerPid =
      spawnedEngine !== undefined
        ? ((await spawnedEngine.pidReady) ?? spawnedEngine.pid)
        : undefined;
    if (endedError !== undefined) throw endedError;
    ready = true;
    return { engine: compositeEngine, peer, reading, providerPid, userAgent };
  } catch (error) {
    await stopConnection({ engine: compositeEngine, reading }, { error });
    throw error;
  }
}
