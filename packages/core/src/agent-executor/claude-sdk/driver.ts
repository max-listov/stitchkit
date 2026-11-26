import type {
  AccountInfo,
  ForkSessionOptions,
  ForkSessionResult,
  McpServerStatus,
  McpSetServersResult,
  ModelInfo,
  Options,
  Query,
  RewindFilesResult,
  SDKControlGetContextUsageResponse,
  SDKControlGetUsageResponse,
  SDKControlInitializeResponse,
  SDKUserMessage,
  SlashCommand,
} from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeRuntimeEvent } from '../claude/events';
import { findTranscriptInput } from '../claude/transcript';
import type { AgentEngineDriver, AgentEngineSession } from '../engine';
import type { ExecutorDriverCapabilities, PlanLimits } from '../hello';
import { type ExecutorProfileConfig, engineProfile } from '../profile';
import type { ExecutorStartupPhase } from '../vocabulary';
import {
  type ClaudeSdkCapabilitiesProbe,
  type ClaudeSdkProbeCapabilitiesInput,
  probeClaudeSdkCapabilities,
} from './probe';
import type { ClaudeSdkPermissionRequestMeta } from './query-loop';
import { validateClaudeSdkConfig } from './query-options';
import { openClaudeSdkSession } from './session';
import type { ClaudeSdkTurnUsage } from './turn-usage';

/** What the leaf uses of a running query; the SDK's `Query` fits as it is. */
export interface ClaudeSdkRun extends AsyncIterable<unknown> {
  interrupt(): Promise<unknown>;
  close?(): void;
  setModel?(model?: string): Promise<void>;
  setPermissionMode?(mode: NonNullable<Options['permissionMode']>): Promise<void>;
  applyFlagSettings?(settings: Parameters<Query['applyFlagSettings']>[0]): Promise<void>;
  initializationResult?(): Promise<SDKControlInitializeResponse>;
  supportedModels?(): Promise<ModelInfo[]>;
  supportedCommands?(): Promise<SlashCommand[]>;
  accountInfo?(): Promise<AccountInfo>;
  getContextUsage?(
    opts?: Parameters<Query['getContextUsage']>[0],
  ): Promise<SDKControlGetContextUsageResponse>;
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?(
    opts?: Parameters<Query['usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET']>[0],
  ): Promise<SDKControlGetUsageResponse>;
  mcpServerStatus?(): Promise<McpServerStatus[]>;
  setMcpServers?(servers: Parameters<Query['setMcpServers']>[0]): Promise<McpSetServersResult>;
  toggleMcpServer?(serverName: string, enabled: boolean): Promise<void>;
  reconnectMcpServer?(serverName: string): Promise<void>;
  stopTask?(taskId: string): Promise<void>;
  backgroundTasks?(toolUseId?: string): Promise<boolean>;
  rewindFiles?(
    userMessageId: string,
    options?: { dryRun?: boolean },
  ): Promise<RewindFilesResult>;
}

/** The SDK's `query`, as the application imported it: the leaf never imports the SDK itself. */
export type ClaudeSdkQuery = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options?: Options;
}) => ClaudeSdkRun;

/**
 * The SDK's `forkSession`, as the application imported it.
 * Note: the upstream SDK resolves local transcripts from `CLAUDE_CONFIG_DIR` or `options.sessionStore`;
 * the driver forwards calls directly without mutating process-global environment variables.
 */
export type ClaudeSdkForkSession = (
  sessionId: string,
  options?: ForkSessionOptions,
) => Promise<ForkSessionResult>;

/** Fail-closed startup verification checks for delegated Claude SDK sessions. */
export interface ClaudeSdkDelegationCheck {
  /** Require `initializationResult().hooks_applied === true` before exposing the query. */
  readonly requireHooksApplied?: boolean;
  /** Require `mcpServerStatus()` to return an empty list before exposing the query. */
  readonly requireNoMcpServers?: boolean;
  /** Maximum milliseconds to wait for delegation verification RPCs. Default 30 000 ms. */
  readonly timeoutMs?: number;
}

/** Context passed to {@link ClaudeSdkDriverConfig.onQueryExit} when a live query exits unexpectedly. */
export interface ClaudeSdkQueryExitContext {
  /** `true` when the query died during an active `startTurn()`, `false` when it exited while idle. */
  readonly duringTurn: boolean;
  /** Session identifier of the affected {@link ClaudeSdkSession}. */
  readonly nativeThreadId: string;
}

/** Result of an active {@link ClaudeSdkSession.readUsage} pull against a live Claude SDK query. */
export type ClaudeSdkUsageRead =
  | {
      /** The active query exposed the usage control RPC and returned a structured response. */
      readonly supported: true;
      /** Normalized plan limits (`known`, `no-plan-limit`, or `unpublished`). */
      readonly planLimits: PlanLimits;
      /** Raw SDK usage report including session totals, `extra_usage`, `model_scoped`, and behaviors. */
      readonly raw: SDKControlGetUsageResponse;
    }
  | {
      /** The active query does not expose the experimental usage control RPC. */
      readonly supported: false;
      /** Honest `unpublished` answer with empty windows. */
      readonly planLimits: PlanLimits;
    };

/** Configuration for {@link createClaudeSdkDriver}. */
export interface ClaudeSdkDriverConfig {
  /** `query` from `@anthropic-ai/claude-agent-sdk`, the version the application chose. */
  query: ClaudeSdkQuery;
  /** That SDK's version, reported in `hello`. */
  sdkVersion: string;
  /** Optional `forkSession` from `@anthropic-ai/claude-agent-sdk` for {@link ClaudeSdkDriver.forkSession}. */
  forkSession?: ClaudeSdkForkSession;
  model?: string;
  /** Default `default`: every tool the profile does not allow is asked of `canUseTool`. */
  permissionMode?: NonNullable<Options['permissionMode']>;
  /** Required by the SDK when `permissionMode` is `'bypassPermissions'`. */
  allowDangerouslySkipPermissions?: Options['allowDangerouslySkipPermissions'];
  /** Explicit host path to the Claude Code executable. */
  pathToClaudeCodeExecutable?: Options['pathToClaudeCodeExecutable'];
  /** System prompt or preset (for example `{ type: 'preset', preset: 'claude_code' }`). */
  systemPrompt?: Options['systemPrompt'];
  /** Setting sources loaded by Claude Code (for example `['user', 'project', 'local']` or `[]`). */
  settingSources?: Options['settingSources'];
  /** Enable file checkpointing so `rewindFiles()` can restore tracked workspace files. */
  enableFileCheckpointing?: Options['enableFileCheckpointing'];
  /** Dialog kinds handled by `onUserDialog`; non-empty lists require `onUserDialog`. */
  supportedDialogKinds?: Options['supportedDialogKinds'];
  /** Callback answering host dialog requests advertised in `supportedDialogKinds`. */
  onUserDialog?: Options['onUserDialog'];
  /** Callback answering MCP elicitation requests (form or URL mode) when no hook handles them. */
  onElicitation?: Options['onElicitation'];
  /**
   * Optional observer invoked with structured `canUseTool` metadata (`decisionReason`,
   * `blockedPath`, `title`, `description`, `suggestions`, `agentID`, `toolUseID`) whenever a
   * tool permission request is held for host approval.
   */
  onPermissionRequest?: (meta: ClaudeSdkPermissionRequestMeta) => void;
  /**
   * Optional observer receiving typed non-delta runtime events (`task_*`, `tool_progress`,
   * `background_tasks_changed`, `api_retry`, `elicitation_complete`) both during turns and
   * between turns while background work runs.
   */
  onEvent?: (event: ClaudeRuntimeEvent) => void;
  /**
   * Optional observer receiving additive per-turn `modelUsage` deltas and non-primary
   * (`otherUsage`) token totals at the end of each turn while preserving cumulative `modelUsage`.
   */
  onTurnUsage?: (usage: ClaudeSdkTurnUsage) => void;
  /** Lifecycle hooks registered on initialize (such as `PreToolUse` delegation guards). */
  hooks?: Options['hooks'];
  /** Built-in tool set available to the session. */
  tools?: Options['tools'];
  /** Tool allowlist passed through to the SDK. */
  allowedTools?: Options['allowedTools'];
  /** Tool denylist passed through to the SDK. */
  disallowedTools?: Options['disallowedTools'];
  /** MCP server definitions passed through to the SDK (pass `{}` to isolate). */
  mcpServers?: Options['mcpServers'];
  /** Controls how MCP server definitions are delivered to the child CLI. */
  mcpServersDelivery?: Options['mcpServersDelivery'];
  /** When `true`, ignore ambient MCP configs outside `mcpServers`. */
  strictMcpConfig?: Options['strictMcpConfig'];
  /** Plugin configurations passed through to the SDK (pass `[]` to isolate). */
  plugins?: Options['plugins'];
  /** Subagent definitions passed through to the SDK (pass `{}` to isolate). */
  agents?: Options['agents'];
  /** Extra CLI flags passed through to the SDK. */
  extraArgs?: Options['extraArgs'];
  /** Callback receiving UTF-8 `stderr` chunks from the spawned Claude Code process. */
  stderr?: Options['stderr'];
  /** Custom process spawner forwarded to the SDK; wrapped to observe `providerPid` when present. */
  spawnClaudeCodeProcess?: Options['spawnClaudeCodeProcess'];
  /** Invoked with the child process PID whenever a query spawns through a spawner exposing `pid`. */
  onProviderPid?: (pid: number) => void;
  /**
   * Invoked when an established query exits unexpectedly before `session.close()` or caller signal
   * abort (including idle exits between turns).
   */
  onQueryExit?: (error: unknown, context: ClaudeSdkQueryExitContext) => void;
  /** Fail-closed startup verification run at `open()` and on every query restart. */
  verifyDelegation?: ClaudeSdkDelegationCheck;
  /** Read the bytes behind a `file` part's `reference`; without it a file part is refused. */
  resolveFile?: (reference: string) => Promise<Uint8Array>;
  /** Maximum decoded size of one image attachment in bytes. Default 5 MiB. */
  maxImageBytes?: number;
  ambient?: Readonly<Record<string, string | undefined>>;
}

/** A Claude SDK session adding live controls, metadata reads, rewind, and observed `providerPid`. */
export interface ClaudeSdkSession extends AgentEngineSession {
  /** PID of the active spawned Claude Code child when observed via a spawner, else `undefined`. */
  readonly providerPid: number | undefined;
  /** Change the model for subsequent turns (or pass `undefined` for default). */
  setModel(model?: string): Promise<void>;
  /** Change the permission mode for subsequent turns. */
  setPermissionMode(mode: NonNullable<Options['permissionMode']>): Promise<void>;
  /** Shallow-merge settings (such as `effortLevel`) into the session flag settings layer. */
  applyFlagSettings(settings: Parameters<Query['applyFlagSettings']>[0]): Promise<void>;
  /** Read the SDK initialize response (commands, models, account, `hooks_applied`). */
  initializationResult(): Promise<SDKControlInitializeResponse>;
  /** List models supported by the live query. */
  supportedModels(): Promise<ModelInfo[]>;
  /** List slash commands / skills supported by the live query. */
  supportedCommands(): Promise<SlashCommand[]>;
  /** Read authenticated account metadata from the live query. */
  accountInfo(): Promise<AccountInfo>;
  /** Read context window usage breakdown from the live query. */
  getContextUsage(
    opts?: Parameters<Query['getContextUsage']>[0],
  ): Promise<SDKControlGetContextUsageResponse>;
  /**
   * Actively pull session usage and plan rate-limit windows from the live query when the
   * configured SDK exposes the `get_usage` control RPC; returns `{ supported: false, planLimits }`
   * with `answer: 'unpublished'` when unavailable.
   */
  readUsage(
    opts?: Parameters<Query['usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET']>[0],
  ): Promise<ClaudeSdkUsageRead>;
  /** Read connection status of configured MCP servers. */
  mcpServerStatus(): Promise<McpServerStatus[]>;
  /** Dynamically replace the session's MCP server definitions over the live control channel. */
  setMcpServers(servers: Parameters<Query['setMcpServers']>[0]): Promise<McpSetServersResult>;
  /** Enable or disable a configured MCP server by name. */
  toggleMcpServer(serverName: string, enabled: boolean): Promise<void>;
  /** Reconnect a configured MCP server by name. */
  reconnectMcpServer(serverName: string): Promise<void>;
  /** Stop a running background task or subagent by its `taskId`. */
  stopTask(taskId: string): Promise<void>;
  /** Background all foreground tasks, or a single task identified by `toolUseId`. */
  backgroundTasks(toolUseId?: string): Promise<boolean>;
  /** Rewind tracked files to the checkpoint recorded at `userMessageId`. */
  rewindFiles(
    userMessageId: string,
    options?: { dryRun?: boolean },
  ): Promise<RewindFilesResult>;
}

/** Input for {@link ClaudeSdkDriver.open}, adding Claude truncating-resume controls. */
export interface ClaudeSdkOpenInput {
  readonly profile: ExecutorProfileConfig;
  readonly cwd: string;
  /** Resume this native session; a fresh one is started without it. */
  readonly nativeThreadId?: string;
  /** Optional observer invoked with startup phases (`spawning`, `verifying`) during open. */
  readonly onStartupPhase?: (phase: ExecutorStartupPhase) => void;
  readonly signal?: AbortSignal;
  /**
   * When resuming (`nativeThreadId` required), truncate history to messages up to and including
   * this chain-entry UUID. Forwarded to SDK `Options.resumeSessionAt` on the initial query.
   */
  readonly resumeSessionAt?: Options['resumeSessionAt'];
  /**
   * With `resumeSessionAt`, declares the prompt UUID of the turn this truncating resume intends
   * to discard. Forwarded to SDK `Options.resumeDropsTurn` on the initial query.
   */
  readonly resumeDropsTurn?: Options['resumeDropsTurn'];
}

/** An {@link AgentEngineDriver} over the Claude Agent SDK with typed live sessions, probing and forking. */
export interface ClaudeSdkDriver extends AgentEngineDriver {
  readonly capabilities: ExecutorDriverCapabilities;
  open(input: ClaudeSdkOpenInput): Promise<ClaudeSdkSession>;
  /** Fork a persisted session transcript through the injected SDK `forkSession` function. */
  forkSession(sessionId: string, options?: ForkSessionOptions): Promise<ForkSessionResult>;
  /**
   * Run a non-inference capability probe (`models`, `commands`, `account`, `initializationResult`,
   * and optionally `usage`) using a never-yielding prompt and guaranteed query teardown.
   */
  probeCapabilities(
    input: ClaudeSdkProbeCapabilitiesInput,
  ): Promise<ClaudeSdkCapabilitiesProbe>;
}

/**
 * Claude through the Agent SDK: the same records as the CLI, read by the
 * same classifier, with permission requests through `canUseTool` and an
 * interrupt through `Query.interrupt()`. A query that breaks fails its turn;
 * the next turn opens a new query that resumes the session.
 */
export function createClaudeSdkDriver(config: ClaudeSdkDriverConfig): ClaudeSdkDriver {
  validateClaudeSdkConfig(config);
  const limits = new Map<string, PlanLimits>();
  const capabilities: ExecutorDriverCapabilities = {
    runtimePolicyEnforcement: 'native',
    sessionApproval: true,
    interruptOnDeny: true,
    updatedToolInput: true,
    structuredInput: false,
    steer: false,
    fork: config.forkSession !== undefined,
    revert: false,
    compact: false,
    injectItems: false,
    backgroundWorkOutlivesTurn: config.onEvent !== undefined,
    multiThreadPerProcess: false,
    images: config.resolveFile !== undefined,
    planLimits: 'pull',
  };
  return {
    engine: 'claude-sdk',
    reconcile: 'client-id',
    capabilities,
    async info() {
      return {
        engine: 'claude-sdk',
        version: config.sdkVersion,
        reconcile: 'client-id',
        models: { answer: 'not-asked' },
        capabilities,
      };
    },
    async status(rawProfile) {
      const profile = engineProfile('claude-sdk', rawProfile);
      const known = limits.get(profile.profileId);
      return {
        login: { state: 'unknown' },
        effectiveCredential: 'unknown',
        ...(known && { planLimits: known }),
      };
    },
    findInput: (input) => findTranscriptInput('claude-sdk', input),
    open: (input) => openClaudeSdkSession(config, limits, input),
    async forkSession(sessionId, options) {
      if (sessionId.trim().length === 0) {
        throw new TypeError('Claude SDK forkSession requires a non-empty sessionId');
      }
      if (config.forkSession === undefined) {
        throw new Error('Claude SDK driver was not configured with forkSession');
      }
      return config.forkSession(sessionId, options);
    },
    probeCapabilities: (input) => probeClaudeSdkCapabilities(config, limits, input),
  };
}
