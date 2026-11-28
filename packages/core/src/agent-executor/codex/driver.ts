import { statSync } from 'node:fs';
import { assertPositiveSafeInteger } from '../../internal/positive-integer';
import { assertEngineWrapCommand, type EngineProcessWrapCommand } from '../engine-process';
import type { PlanLimits } from '../hello';
import { validateImageOptions } from '../image-input';
import type { JsonRpcValue } from '../json-rpc-peer';
import { planLimitsReadFailed } from '../plan-limits';
import { type ExecutorProfileConfig, engineProfile } from '../profile';
import { runEngineCli, withEphemeralConnection } from '../session-primitives';
import { codexDriverCapabilities } from './capabilities';
import {
  type CodexTransportConfig,
  connectCodex,
  validateCodexTransportAndArgs,
} from './connect';
import { type CodexControlClient, createCodexControlClient } from './control-client';
import type { CodexNotificationEvent, CodexServerRequestEvent } from './handlers';
import { CodexLimitBook } from './limits';
import { findCodexTurnByClientId } from './pagination';
import type { CodexApprovalPolicy, CodexSandboxMode, CodexThreadContext } from './protocol';
import { openCodexControlConnection, openCodexSession } from './session';
import { validateCodexPolicyOverrides } from './session-controls';
import type {
  CodexDriver,
  CodexOpenForkOptions,
  CodexThreadPolicyOverrides,
} from './session-types';
import { openCodexSharedServer } from './shared-server';
import type { CodexSessionConfig } from './thread-open';

/**
 * Bounded stdout/frame limit for `thread/turns/list` (64 MiB): a 50-turn page with
 * `itemsView: 'full'` may carry several base64-encoded image turns on one JSON-RPC line.
 */
const FIND_INPUT_MAX_LINE_BYTES = 64 * 1024 * 1024;

/** Configuration for {@link createCodexDriver}. */
export interface CodexDriverConfig {
  /** The CLI to run. Default `codex`, found on the engine's `PATH`. */
  executable?: string | undefined;
  /** Arguments before the driver's own — a runtime running a script, as a fake engine is run. */
  prefixArgs?: readonly string[] | undefined;
  /**
   * Transport for `codex app-server`: `'stdio'` (default), `'unix-listen'` (spawns with
   * `--listen unix://<path>` so another client can attach to the same writer), or
   * `'unix-connect'` (attaches to an existing app-server without owning its lifecycle).
   */
  transport?: CodexTransportConfig | undefined;
  /** Additional CLI arguments appended to `codex app-server` (for example `-c` overrides); must not include `--listen` or `--stdio`. */
  serverArgs?: readonly string[] | undefined;
  /** Default model id passed to `thread/start` and `thread/resume`. */
  model?: string | undefined;
  /** Default model provider passed to `thread/start` and `thread/resume`. */
  modelProvider?: string | undefined;
  /** `approvalPolicy` of a new or resumed thread. Default `on-request`: the engine asks the host. */
  approvalPolicy?: CodexApprovalPolicy | undefined;
  /** `sandbox` of a new or resumed thread. Default `workspace-write`. */
  sandbox?: CodexSandboxMode | undefined;
  /** Developer instructions passed to `thread/start` and `thread/resume`. */
  developerInstructions?: string | undefined;
  /** Additional workspace roots allowed for runtime filesystem access on the thread. */
  runtimeWorkspaceRoots?: readonly string[] | undefined;
  /** Codex app-server config overrides passed on `thread/start` and `thread/resume` (writable roots, disabled MCP/plugins/features, network policy). */
  config?: Readonly<Record<string, JsonRpcValue>> | undefined;
  /**
   * Optional hook invoked after `initialize` and before `thread/start` or `thread/resume`.
   * May inspect server state (`readConfig`, `listModels`, etc.) and return dynamic per-thread policy overrides;
   * throwing stops the connection cleanly before opening the thread.
   */
  prepareThread?:
    | ((context: {
        readonly controls: CodexControlClient;
        readonly cwd: string;
        readonly nativeThreadId?: string | undefined;
        readonly forkFrom?: CodexOpenForkOptions | undefined;
      }) =>
        | Promise<CodexThreadPolicyOverrides | undefined>
        | CodexThreadPolicyOverrides
        | undefined)
    | undefined;
  /**
   * Optional hook invoked immediately after `thread/start`, `thread/resume`, or `thread/fork` succeeds.
   * May inspect the applied `threadContext` or call `listMcpServerStatus`/`listSkills`;
   * throwing fails `open()` and stops the connection cleanly.
   */
  verifyThread?:
    | ((context: {
        readonly nativeThreadId: string;
        readonly threadContext: CodexThreadContext;
        readonly controls: CodexControlClient;
      }) => Promise<void> | void)
    | undefined;
  /**
   * Optional observer invoked for every Codex app-server notification (both during `startTurn()`
   * and for external/TUI turns or lifecycle updates like `thread/status/changed` and `turn/started`).
   */
  onNotification?: ((event: CodexNotificationEvent) => void) | undefined;
  /**
   * Optional handler for known server requests (`commandExecution`, `fileChange`, `permissions`
   * approvals, `requestUserInput`, and `mcpServer/elicitation/request`). By default invoked only
   * outside `startTurn()` (for example from an attached TUI client); set `serverRequestDelivery: 'all'`
   * to also deliver requests arriving during a driver-initiated `startTurn()`.
   * When omitted, requests outside `startTurn()` are refused `-32601`.
   */
  onServerRequest?: ((event: CodexServerRequestEvent) => void) | undefined;
  /**
   * Controls which server requests reach `onServerRequest`: `'external-only'` (default, only
   * requests outside `startTurn()`) or `'all'` (also notifies `onServerRequest` during active
   * `startTurn()` runs with `duringActiveTurn: true`, backed by the same single-shot `turn.pending`
   * slot). Setting `'all'` requires `onServerRequest`.
   */
  serverRequestDelivery?: 'external-only' | 'all' | undefined;
  /**
   * Optional callback invoked immediately when an established session or control connection drops
   * unexpectedly before `close()` or caller signal abort (including idle socket disconnects).
   */
  onDisconnect?: ((error: Error) => void) | undefined;
  /**
   * Receives every failure of a host callback the driver contained to keep reading its engine:
   * `hook` is the option that threw or rejected (`'onNotification'`, `'onServerRequest'`,
   * `'onDisconnect'`, `'onStartupPhase'`), or `'driver:notification'` for a failure inside a
   * shared server's own handling of one notification. A `JsonRpcError` thrown by
   * `onServerRequest` for a request outside `startTurn()` is that observer's refusal and is not
   * reported. Without this option such
   * failures are contained and dropped; a handler that itself throws is ignored.
   */
  onObserverError?: ((error: unknown, hook: string) => void) | undefined;
  /** Maximum incoming JSON-RPC frame/line size in bytes (WebSocket default 16 MiB, stdio default 8 MiB). */
  maxFrameBytes?: number | undefined;
  /** Read the bytes behind a `file` part's `reference`; without it a file part is refused. */
  resolveFile?: ((reference: string) => Promise<Uint8Array>) | undefined;
  /** Maximum decoded size of one image attachment in bytes. Default 5 MiB. */
  maxImageBytes?: number | undefined;
  /** Environment variables inherited by the spawned Codex CLI process. */
  ambient?: Readonly<Record<string, string | undefined>> | undefined;
  /** Optional command wrapper invoked before spawning Codex (for example an OS process sandbox). */
  wrapCommand?: EngineProcessWrapCommand | undefined;
}

function existingDirectory(path: string): string | undefined {
  try {
    return statSync(path).isDirectory() ? path : undefined;
  } catch {
    return undefined;
  }
}

function validateCodexDriverOptions(config: CodexDriverConfig): void {
  validateImageOptions(config);
  assertPositiveSafeInteger('maxFrameBytes', config.maxFrameBytes);
  assertEngineWrapCommand(config.wrapCommand, 'createCodexDriver');
  validateCodexTransportAndArgs(config);
  validateCodexPolicyOverrides(config, 'createCodexDriver');
  if (
    config.serverRequestDelivery !== undefined &&
    config.serverRequestDelivery !== 'external-only' &&
    config.serverRequestDelivery !== 'all'
  ) {
    throw new TypeError(
      `[stitchkit] createCodexDriver: serverRequestDelivery must be "external-only" or "all", received ${JSON.stringify(config.serverRequestDelivery)}`,
    );
  }
  if (config.serverRequestDelivery === 'all' && config.onServerRequest === undefined) {
    throw new TypeError(
      '[stitchkit] createCodexDriver: serverRequestDelivery "all" requires onServerRequest',
    );
  }
}

function buildCodexSessionConfig(input: {
  readonly config: CodexDriverConfig;
  readonly executable: string;
  readonly prefix: readonly string[];
  readonly ambient: Readonly<Record<string, string | undefined>>;
  readonly limits: CodexLimitBook;
  readonly version: string;
  readonly maxFrameBytes?: number;
  readonly forceStdioForListen?: boolean;
  readonly ephemeralProbe?: boolean;
}): CodexSessionConfig {
  const { config } = input;
  const transport =
    input.forceStdioForListen && config.transport?.kind === 'unix-listen'
      ? ({ kind: 'stdio' } as const)
      : config.transport;
  const maxFrameBytes = input.maxFrameBytes ?? config.maxFrameBytes;
  return {
    executable: input.executable,
    prefix: input.prefix,
    ...(transport !== undefined && { transport }),
    ...(config.serverArgs !== undefined && { serverArgs: config.serverArgs }),
    ...(config.model !== undefined && { model: config.model }),
    ...(config.modelProvider !== undefined && { modelProvider: config.modelProvider }),
    approvalPolicy: config.approvalPolicy ?? 'on-request',
    sandbox: config.sandbox ?? 'workspace-write',
    ...(config.developerInstructions !== undefined && {
      developerInstructions: config.developerInstructions,
    }),
    ...(config.runtimeWorkspaceRoots !== undefined && {
      runtimeWorkspaceRoots: config.runtimeWorkspaceRoots,
    }),
    ...(config.config !== undefined && { config: config.config }),
    ...(config.prepareThread !== undefined && { prepareThread: config.prepareThread }),
    ...(config.verifyThread !== undefined && { verifyThread: config.verifyThread }),
    ...(!input.ephemeralProbe &&
      config.onNotification !== undefined && { onNotification: config.onNotification }),
    ...(!input.ephemeralProbe &&
      config.onServerRequest !== undefined && { onServerRequest: config.onServerRequest }),
    ...(!input.ephemeralProbe &&
      config.serverRequestDelivery !== undefined && {
        serverRequestDelivery: config.serverRequestDelivery,
      }),
    ...(!input.ephemeralProbe &&
      config.onDisconnect !== undefined && { onDisconnect: config.onDisconnect }),
    ...(config.onObserverError !== undefined && { onObserverError: config.onObserverError }),
    ambient: input.ambient,
    ...(config.wrapCommand !== undefined && { wrapCommand: config.wrapCommand }),
    limits: input.limits,
    version: input.version,
    ...(config.resolveFile !== undefined && { resolveFile: config.resolveFile }),
    ...(config.maxImageBytes !== undefined && { maxImageBytes: config.maxImageBytes }),
    ...(maxFrameBytes !== undefined && { maxFrameBytes }),
  };
}

/**
 * Codex through its app-server over stdio or WebSocket-over-Unix-socket: a thread
 * per session, policy and delegation overrides, `turn/start` under the executor's
 * `clientUserMessageId`, per-turn overrides, live session controls (`turn/steer`,
 * `turn/interrupt`, `thread/resume`, `thread/fork`, `thread/compact/start`,
 * config/MCP/skills/models/account reads), multi-bucket `account/rateLimits/read`,
 * and reconcile by client id in `thread/turns/list`.
 */
export function createCodexDriver(config: CodexDriverConfig = {}): CodexDriver {
  validateCodexDriverOptions(config);
  const executable = config.executable ?? 'codex';
  const prefix = config.prefixArgs ?? [];
  const ambient = config.ambient ?? process.env;
  const limits = new CodexLimitBook();
  let version = 'unknown';
  const capabilities = codexDriverCapabilities({ images: config.resolveFile !== undefined });

  const session = (options?: {
    readonly maxFrameBytes?: number;
    readonly forceStdioForListen?: boolean;
    readonly ephemeralProbe?: boolean;
  }): CodexSessionConfig =>
    buildCodexSessionConfig({
      config,
      executable,
      prefix,
      ambient,
      limits,
      version,
      ...options,
    });

  const cli = (profile: ExecutorProfileConfig, args: string[], cwd?: string) =>
    runEngineCli({
      executable,
      prefix,
      args,
      profile,
      ambient,
      ...(cwd !== undefined && { cwd }),
      ...(config.wrapCommand !== undefined && { wrapCommand: config.wrapCommand }),
    });

  /**
   * Open an ephemeral app-server connection for one-shot probes (`status`, `findInput`).
   * In `unix-listen` mode, probes use `stdio` so they never collide with a live session's
   * Unix socket path.
   */
  const ask = <T>(
    profile: ExecutorProfileConfig,
    cwd: string,
    question: (peer: Awaited<ReturnType<typeof connectCodex>>['peer']) => Promise<T>,
    maxFrameBytes?: number,
  ) =>
    withEphemeralConnection(
      (signal) =>
        connectCodex(
          session({
            ...(maxFrameBytes !== undefined && { maxFrameBytes }),
            forceStdioForListen: true,
            ephemeralProbe: true,
          }),
          engineProfile('codex', profile),
          cwd,
          signal,
        ),
      (connection) => question(connection.peer),
    );

  return {
    engine: 'codex',
    reconcile: 'client-id',
    capabilities,
    async info() {
      const probe = {
        profileId: 'version-probe',
        engine: 'codex' as const,
        home: ambient.HOME ?? '/',
      };
      const probeCwd = existingDirectory(probe.home) ?? process.cwd();
      const result = await cli(probe, ['--version'], probeCwd);
      const out = result.exitCode === 0 ? new TextDecoder().decode(result.stdout).trim() : '';
      version = out.split(/\s+/).at(-1) || 'unknown';
      return {
        engine: 'codex',
        version,
        reconcile: 'client-id',
        models: { answer: 'not-asked' },
        capabilities,
      };
    },
    async status(profile) {
      const parsed = engineProfile('codex', profile);
      const probeCwd = existingDirectory(parsed.home) ?? process.cwd();
      const loginResult = await cli(parsed, ['login', 'status'], probeCwd);
      const decoder = new TextDecoder();
      // Real `codex login status` writes its status line to stderr; check both streams.
      const text =
        `${decoder.decode(loginResult.stdout)}\n${decoder.decode(loginResult.stderr)}`.trim();
      const line = text
        .split(/\r?\n/)
        .map((value) => value.trim())
        .find((value) => /^Logged in(?:\s|$)/i.test(value));
      const signedIn = loginResult.exitCode === 0 && line !== undefined;
      const signedOut = loginResult.exitCode === 1 && /^Not logged in\s*$/im.test(text);
      const credential = signedIn
        ? /chatgpt/i.test(line)
          ? 'subscription'
          : /api key/i.test(line)
            ? 'api-key'
            : 'unknown'
        : signedOut
          ? 'none'
          : 'unknown';
      let planLimits: PlanLimits | undefined;
      if (credential === 'subscription') {
        try {
          const answer = await ask(parsed, probeCwd, (peer) =>
            peer.request('account/rateLimits/read'),
          );
          planLimits = limits.replace(parsed.profileId, answer, new Date());
        } catch (error) {
          planLimits = planLimitsReadFailed({
            previous: limits.get(parsed.profileId),
            error: error instanceof Error ? error.message : String(error),
            now: new Date(),
          });
        }
      } else if (credential === 'api-key') {
        limits.delete(parsed.profileId);
        planLimits = {
          answer: 'no-plan-limit',
          windows: [],
          observedAt: new Date().toISOString(),
        };
      }
      if (signedOut) limits.delete(parsed.profileId);
      if (credential === 'unknown') {
        const previous = limits.get(parsed.profileId);
        if (previous !== undefined)
          planLimits = planLimitsReadFailed({
            previous,
            error: 'Codex login status could not confirm the credential',
            now: new Date(),
          });
      }
      return {
        login: { state: signedIn ? 'signed-in' : signedOut ? 'signed-out' : 'unknown' },
        effectiveCredential: credential,
        ...(planLimits && { planLimits }),
      };
    },
    async findInput(input) {
      return ask(
        input.profile,
        input.cwd,
        async (peer) => {
          const controls = createCodexControlClient({
            peer,
            imageOptions: config,
            signal: new AbortController().signal,
            ensureAlive: () => undefined,
          });
          const found = await findCodexTurnByClientId(controls, {
            threadId: input.nativeThreadId,
            clientId: input.clientId,
          });
          return found !== null;
        },
        Math.max(FIND_INPUT_MAX_LINE_BYTES, config.maxFrameBytes ?? 0),
      );
    },
    open: (input) => openCodexSession(session(), input),
    connectControl: (input) => openCodexControlConnection(session(), input),
    openSharedServer: (input) => openCodexSharedServer(session(), capabilities, input),
  };
}
