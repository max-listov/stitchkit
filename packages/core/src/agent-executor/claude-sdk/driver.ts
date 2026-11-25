import type {
  AccountInfo,
  ForkSessionOptions,
  ForkSessionResult,
  McpServerStatus,
  ModelInfo,
  Options,
  Query,
  RewindFilesResult,
  SDKControlGetContextUsageResponse,
  SDKControlInitializeResponse,
  SDKUserMessage,
  SlashCommand,
} from '@anthropic-ai/claude-agent-sdk';
import { findTranscriptInput } from '../claude/transcript';
import type { AgentEngineDriver, AgentEngineSession } from '../engine';
import type { PlanLimits } from '../hello';
import { engineProfile } from '../profile';
import { validateClaudeSdkConfig } from './query-options';
import { openClaudeSdkSession } from './session';

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
  mcpServerStatus?(): Promise<McpServerStatus[]>;
  toggleMcpServer?(serverName: string, enabled: boolean): Promise<void>;
  reconnectMcpServer?(serverName: string): Promise<void>;
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
  /** Read connection status of configured MCP servers. */
  mcpServerStatus(): Promise<McpServerStatus[]>;
  /** Enable or disable a configured MCP server by name. */
  toggleMcpServer(serverName: string, enabled: boolean): Promise<void>;
  /** Reconnect a configured MCP server by name. */
  reconnectMcpServer(serverName: string): Promise<void>;
  /** Rewind tracked files to the checkpoint recorded at `userMessageId`. */
  rewindFiles(
    userMessageId: string,
    options?: { dryRun?: boolean },
  ): Promise<RewindFilesResult>;
}

/** An {@link AgentEngineDriver} over the Claude Agent SDK with typed live sessions and session forking. */
export interface ClaudeSdkDriver extends AgentEngineDriver {
  open(input: Parameters<AgentEngineDriver['open']>[0]): Promise<ClaudeSdkSession>;
  /** Fork a persisted session transcript through the injected SDK `forkSession` function. */
  forkSession(sessionId: string, options?: ForkSessionOptions): Promise<ForkSessionResult>;
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
  return {
    engine: 'claude-sdk',
    reconcile: 'client-id',
    async info() {
      return {
        engine: 'claude-sdk',
        version: config.sdkVersion,
        reconcile: 'client-id',
        models: { answer: 'not-asked' },
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
  };
}
