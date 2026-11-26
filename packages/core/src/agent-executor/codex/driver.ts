import { assertPositiveSafeInteger } from '../../internal/positive-integer';
import type { ExecutorDriverCapabilities, PlanLimits } from '../hello';
import { validateImageOptions } from '../image-input';
import type { JsonRpcPeer, JsonRpcValue } from '../json-rpc-peer';
import { mergeRateLimitEvent, planLimitsReadFailed } from '../plan-limits';
import { type ExecutorProfileConfig, engineProfile } from '../profile';
import { runEngineCli, withEphemeralConnection } from '../session-primitives';
import {
  type CodexTransportConfig,
  connectCodex,
  validateCodexTransportAndArgs,
} from './connect';
import type { CodexControlClient } from './control-client';
import type { CodexNotificationEvent, CodexServerRequestEvent } from './handlers';
import { codexPlanWindows } from './limits';
import {
  type CodexApprovalPolicy,
  type CodexSandboxMode,
  type CodexThreadContext,
  CodexTurnsPageSchema,
} from './protocol';
import { openCodexControlConnection, openCodexSession } from './session';
import {
  type CodexDriver,
  type CodexOpenForkOptions,
  type CodexThreadPolicyOverrides,
  validateCodexPolicyOverrides,
} from './session-controls';
import { openCodexSharedServer } from './shared-server';
import type { CodexSessionConfig } from './thread-open';

/** Upper bound on paginated `thread/turns/list` requests in one `findInput` call. */
const MAX_HISTORY_PAGES = 256;
/**
 * Bounded stdout/frame limit for `thread/turns/list` (64 MiB): a 50-turn page with
 * `itemsView: 'full'` may carry several base64-encoded image turns on one JSON-RPC line.
 */
const FIND_INPUT_MAX_LINE_BYTES = 64 * 1024 * 1024;

async function findCodexClientInput(
  peer: JsonRpcPeer,
  nativeThreadId: string,
  clientId: string,
): Promise<boolean> {
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < MAX_HISTORY_PAGES; pageNumber += 1) {
    const page = CodexTurnsPageSchema.parse(
      await peer.request('thread/turns/list', {
        threadId: nativeThreadId,
        limit: 50,
        itemsView: 'full',
        ...(cursor !== undefined && { cursor }),
      }),
    );
    if (
      page.data.some((turn) =>
        turn.items.some((item) => item.type === 'userMessage' && item.clientId === clientId),
      )
    ) {
      return true;
    }
    const next = page.nextCursor;
    if (next === null || next === undefined) return false;
    if (seen.has(next)) {
      throw new Error(
        `Codex thread/turns/list repeated cursor ${JSON.stringify(next)} before history ended`,
      );
    }
    seen.add(next);
    cursor = next;
  }
  throw new Error(
    `Codex thread/turns/list exceeded ${MAX_HISTORY_PAGES} pages without reaching the end of history`,
  );
}

/** Configuration for {@link createCodexDriver}. */
export interface CodexDriverConfig {
  /** The CLI to run. Default `codex`, found on the engine's `PATH`. */
  executable?: string;
  /** Arguments before the driver's own — a runtime running a script, as a fake engine is run. */
  prefixArgs?: readonly string[];
  /**
   * Transport for `codex app-server`: `'stdio'` (default), `'unix-listen'` (spawns with
   * `--listen unix://<path>` so another client can attach to the same writer), or
   * `'unix-connect'` (attaches to an existing app-server without owning its lifecycle).
   */
  transport?: CodexTransportConfig;
  /** Additional CLI arguments appended to `codex app-server` (for example `-c` overrides); must not include `--listen` or `--stdio`. */
  serverArgs?: readonly string[];
  /** Default model id passed to `thread/start` and `thread/resume`. */
  model?: string;
  /** Default model provider passed to `thread/start` and `thread/resume`. */
  modelProvider?: string;
  /** `approvalPolicy` of a new or resumed thread. Default `on-request`: the engine asks the host. */
  approvalPolicy?: CodexApprovalPolicy;
  /** `sandbox` of a new or resumed thread. Default `workspace-write`. */
  sandbox?: CodexSandboxMode;
  /** Developer instructions passed to `thread/start` and `thread/resume`. */
  developerInstructions?: string;
  /** Additional workspace roots allowed for runtime filesystem access on the thread. */
  runtimeWorkspaceRoots?: readonly string[];
  /** Codex app-server config overrides passed on `thread/start` and `thread/resume` (writable roots, disabled MCP/plugins/features, network policy). */
  config?: Readonly<Record<string, JsonRpcValue>>;
  /**
   * Optional hook invoked after `initialize` and before `thread/start` or `thread/resume`.
   * May inspect server state (`readConfig`, `listModels`, etc.) and return dynamic per-thread policy overrides;
   * throwing stops the connection cleanly before opening the thread.
   */
  prepareThread?: (context: {
    readonly controls: CodexControlClient;
    readonly cwd: string;
    readonly nativeThreadId?: string;
    readonly forkFrom?: CodexOpenForkOptions;
  }) =>
    | Promise<CodexThreadPolicyOverrides | undefined>
    | CodexThreadPolicyOverrides
    | undefined;
  /**
   * Optional hook invoked immediately after `thread/start`, `thread/resume`, or `thread/fork` succeeds.
   * May inspect the applied `threadContext` or call `listMcpServerStatus`/`listSkills`;
   * throwing fails `open()` and stops the connection cleanly.
   */
  verifyThread?: (context: {
    readonly nativeThreadId: string;
    readonly threadContext: CodexThreadContext;
    readonly controls: CodexControlClient;
  }) => Promise<void> | void;
  /**
   * Optional observer invoked for every Codex app-server notification (both during `startTurn()`
   * and for external/TUI turns or lifecycle updates like `thread/status/changed` and `turn/started`).
   */
  onNotification?: (event: CodexNotificationEvent) => void;
  /**
   * Optional handler for known server requests (`commandExecution`, `fileChange`, `permissions`
   * approvals, `requestUserInput`, and `mcpServer/elicitation/request`). By default invoked only
   * outside `startTurn()` (for example from an attached TUI client); set `serverRequestDelivery: 'all'`
   * to also deliver requests arriving during a driver-initiated `startTurn()`.
   * When omitted, requests outside `startTurn()` are refused `-32601`.
   */
  onServerRequest?: (event: CodexServerRequestEvent) => void;
  /**
   * Controls which server requests reach `onServerRequest`: `'external-only'` (default, only
   * requests outside `startTurn()`) or `'all'` (also notifies `onServerRequest` during active
   * `startTurn()` runs with `duringActiveTurn: true`, backed by the same single-shot `turn.pending`
   * slot). Setting `'all'` requires `onServerRequest`.
   */
  serverRequestDelivery?: 'external-only' | 'all';
  /**
   * Optional callback invoked immediately when an established session or control connection drops
   * unexpectedly before `close()` or caller signal abort (including idle socket disconnects).
   */
  onDisconnect?: (error: Error) => void;
  /** Maximum incoming JSON-RPC frame/line size in bytes (WebSocket default 16 MiB, stdio default 8 MiB). */
  maxFrameBytes?: number;
  /** Read the bytes behind a `file` part's `reference`; without it a file part is refused. */
  resolveFile?: (reference: string) => Promise<Uint8Array>;
  /** Maximum decoded size of one image attachment in bytes. Default 5 MiB. */
  maxImageBytes?: number;
  ambient?: Readonly<Record<string, string | undefined>>;
}

function validateCodexDriverOptions(config: CodexDriverConfig): void {
  validateImageOptions(config);
  assertPositiveSafeInteger('maxFrameBytes', config.maxFrameBytes);
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
  readonly limits: Map<string, PlanLimits>;
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
    ambient: input.ambient,
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
  const limits = new Map<string, PlanLimits>();
  let version = 'unknown';
  const capabilities: ExecutorDriverCapabilities = {
    runtimePolicyEnforcement: 'native',
    sessionApproval: true,
    interruptOnDeny: true,
    updatedToolInput: false,
    structuredInput: true,
    steer: true,
    fork: true,
    revert: true,
    compact: true,
    injectItems: true,
    backgroundWorkOutlivesTurn: false,
    multiThreadPerProcess: false,
    images: config.resolveFile !== undefined,
    planLimits: 'pull',
  };

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

  const cli = (profile: ExecutorProfileConfig, args: string[]) =>
    runEngineCli({ executable, prefix, args, profile, ambient });

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
      const result = await cli(probe, ['--version']);
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
      const loginResult = await cli(parsed, ['login', 'status']);
      const decoder = new TextDecoder();
      // Real `codex login status` writes its status line to stderr; check both streams.
      const text =
        `${decoder.decode(loginResult.stdout)}\n${decoder.decode(loginResult.stderr)}`.trim();
      const signedIn = loginResult.exitCode === 0 && /(?:^|\n)Logged in/im.test(text);
      const credential = !signedIn
        ? 'none'
        : /chatgpt/i.test(text)
          ? 'subscription'
          : /api key/i.test(text)
            ? 'api-key'
            : 'unknown';
      let planLimits: PlanLimits | undefined = limits.get(parsed.profileId);
      if (credential === 'subscription') {
        try {
          const answer = await ask(parsed, process.cwd(), (peer) =>
            peer.request('account/rateLimits/read'),
          );
          const windows = codexPlanWindows(answer);
          planLimits = mergeRateLimitEvent({ previous: planLimits, windows, now: new Date() });
          limits.set(parsed.profileId, planLimits);
        } catch (error) {
          planLimits = planLimitsReadFailed({
            previous: planLimits,
            error: error instanceof Error ? error.message : String(error),
            now: new Date(),
          });
        }
      } else if (credential === 'api-key') {
        planLimits = {
          answer: 'no-plan-limit',
          windows: [],
          observedAt: new Date().toISOString(),
        };
      }
      return {
        login: { state: signedIn ? 'signed-in' : 'signed-out' },
        effectiveCredential: credential,
        ...(planLimits && { planLimits }),
      };
    },
    async findInput(input) {
      return ask(
        input.profile,
        input.cwd,
        (peer) => findCodexClientInput(peer, input.nativeThreadId, input.clientId),
        Math.max(FIND_INPUT_MAX_LINE_BYTES, config.maxFrameBytes ?? 0),
      );
    },
    open: (input) => openCodexSession(session(), input),
    connectControl: (input) => openCodexControlConnection(session(), input),
    openSharedServer: (input) => openCodexSharedServer(session(), capabilities, input),
  };
}
