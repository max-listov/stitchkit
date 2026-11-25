import type { AgentMessagePart } from '../../agent-parts/parts';
import type { AgentEngineDriver, AgentEngineSession, AgentEngineTurn } from '../engine';
import { type DriverImageOptions, type InlinedPart, inlineParts } from '../image-input';
import type { JsonRpcPeer, JsonRpcValue } from '../json-rpc-peer';
import { safeJsonValue } from '../session-primitives';
import {
  type CodexApprovalPolicy,
  type CodexCollaborationMode,
  CodexCollaborationModeSchema,
  type CodexSandboxMode,
  CodexStartedThreadSchema,
  type CodexThreadContext,
  CodexTurnSteerResponseSchema,
  extractCodexThreadContext,
} from './protocol';

/** Policy and configuration fields forwarded to Codex `thread/start`, `thread/resume`, and `thread/fork`. */
export interface CodexThreadPolicyOverrides {
  /** Model identifier to use for the thread. */
  readonly model?: string;
  /** Model provider identifier (for example `openai`). */
  readonly modelProvider?: string;
  /** Approval policy applied to the thread. */
  readonly approvalPolicy?: CodexApprovalPolicy;
  /** Sandbox mode applied to the thread. */
  readonly sandbox?: CodexSandboxMode;
  /** Developer instructions appended to the thread system context. */
  readonly developerInstructions?: string;
  /** Additional workspace roots allowed for runtime filesystem access. */
  readonly runtimeWorkspaceRoots?: readonly string[];
  /** Codex app-server config overrides for the thread (sandbox writable roots, disabled MCP/plugins/features, network policy). */
  readonly config?: Readonly<Record<string, JsonRpcValue>>;
}

/** Read-only and inspection RPCs exposed during thread setup (`prepareThread` / `verifyThread`) and on {@link CodexSession}. */
export interface CodexControlClient {
  /** Read effective Codex configuration (`config/read`). */
  readConfig(params?: {
    readonly cwd?: string;
    readonly includeLayers?: boolean;
  }): Promise<JsonRpcValue>;
  /** List MCP servers and their statuses (`mcpServerStatus/list`). */
  listMcpServerStatus(params?: {
    readonly cursor?: string;
    readonly limit?: number;
    readonly threadId?: string;
    readonly serverName?: string;
    readonly detail?: string;
  }): Promise<JsonRpcValue>;
  /** List discovered Codex skills (`skills/list`). */
  listSkills(params?: {
    readonly cwds?: readonly string[];
    readonly forceReload?: boolean;
  }): Promise<JsonRpcValue>;
  /** List available models (`model/list`). */
  listModels(params?: {
    readonly cursor?: string;
    readonly limit?: number;
    readonly includeHidden?: boolean;
    readonly modelProvider?: string;
  }): Promise<JsonRpcValue>;
  /** Read active account information (`account/read`). */
  readAccount(params?: { readonly refreshToken?: boolean }): Promise<JsonRpcValue>;
  /** Read the raw `account/rateLimits/read` response envelope. */
  readRateLimits(): Promise<JsonRpcValue>;
}

/** Input to {@link CodexSession.startTurn}, extending the portable turn input with Codex per-turn overrides. */
export interface CodexTurnInput {
  readonly turnId: string;
  readonly clientId: string;
  readonly input: readonly AgentMessagePart[];
  /** Per-turn model override forwarded on `turn/start`. */
  readonly model?: string;
  /**
   * Verified fail-closed against the thread's active `modelProvider`; Codex's `turn/start`
   * does not switch providers mid-thread.
   */
  readonly modelProvider?: string;
  /** Per-turn reasoning effort override (forwarded to Codex as `effort`). */
  readonly reasoningEffort?: string;
  /** Per-turn collaboration mode override (`plan` or `default`). */
  readonly collaborationMode?: CodexCollaborationMode;
  /** Per-turn approval policy override. */
  readonly approvalPolicy?: CodexApprovalPolicy;
  /** Per-turn sandbox policy object override (`sandboxPolicy`). */
  readonly sandboxPolicy?: JsonRpcValue;
  /** Per-turn runtime workspace roots override. */
  readonly runtimeWorkspaceRoots?: readonly string[];
}

/** Input to {@link CodexSession.steerTurn} (`turn/steer`). */
export interface CodexSteerTurnInput {
  readonly input: readonly AgentMessagePart[];
  readonly clientId?: string;
  /** Optional guard asserting which active Codex turn id is being steered. */
  readonly expectedTurnId?: string;
}

/** Options for {@link CodexSession.forkThread} (`thread/fork`). */
export interface CodexForkThreadOptions extends CodexThreadPolicyOverrides {
  readonly cwd?: string;
  readonly beforeTurnId?: string;
  readonly lastTurnId?: string;
  readonly excludeTurns?: boolean;
}

/** Result returned by {@link CodexSession.forkThread} without mutating the current session. */
export interface CodexForkedThread {
  readonly nativeThreadId: string;
  readonly threadContext: CodexThreadContext;
}

/** Extended Codex session handle exposing `providerPid`, applied `threadContext`, and live app-server controls. */
export interface CodexSession extends AgentEngineSession, CodexControlClient {
  /** OS process id of the spawned `codex app-server`, or `undefined` when attached via `unix-connect`. */
  readonly providerPid: number | undefined;
  /** Applied thread settings reported by `thread/start` or `thread/resume`. */
  readonly threadContext: CodexThreadContext;
  /** Start a turn with optional per-turn Codex overrides. */
  startTurn(input: CodexTurnInput): Promise<AgentEngineTurn>;
  /** Steer the currently running turn with additional input (`turn/steer`). */
  steerTurn(input: CodexSteerTurnInput): Promise<{ readonly turnId: string }>;
  /** Fork the session's thread into a new thread id without mutating the current session (`thread/fork`). */
  forkThread(options?: CodexForkThreadOptions): Promise<CodexForkedThread>;
  /** Request context compaction for the current thread (`thread/compact/start`). */
  compactThread(): Promise<void>;
}

/** Codex driver returned by {@link createCodexDriver}; `open()` resolves to a {@link CodexSession}. */
export interface CodexDriver extends AgentEngineDriver {
  readonly engine: 'codex';
  readonly reconcile: 'client-id';
  findInput: NonNullable<AgentEngineDriver['findInput']>;
  open(input: Parameters<AgentEngineDriver['open']>[0]): Promise<CodexSession>;
}

/** Encode validated host-inlined text and image parts into Codex app-server wire input items. */
export function codexTurnInput(parts: readonly InlinedPart[]): JsonRpcValue[] {
  if (parts.every((part) => part.type === 'text')) {
    return [
      { type: 'text', text: parts.map((part) => part.text).join('\n'), text_elements: [] },
    ];
  }
  const out: JsonRpcValue[] = [];
  for (const part of parts) {
    if (part.type === 'text') {
      out.push({ type: 'text', text: part.text, text_elements: [] });
    } else {
      out.push({ type: 'image', url: `data:${part.mediaType};base64,${part.base64}` });
    }
  }
  return out;
}

/** Validate `runtimeWorkspaceRoots` and `config` policy overrides before sending them to Codex. */
export function validateCodexPolicyOverrides(
  overrides: Pick<CodexThreadPolicyOverrides, 'runtimeWorkspaceRoots' | 'config'>,
  caller: string,
): void {
  if (overrides.runtimeWorkspaceRoots !== undefined) {
    if (!Array.isArray(overrides.runtimeWorkspaceRoots)) {
      throw new TypeError(
        `[stitchkit] ${caller}: runtimeWorkspaceRoots must be an array of strings`,
      );
    }
    for (const root of overrides.runtimeWorkspaceRoots) {
      if (typeof root !== 'string' || root.trim().length === 0) {
        throw new TypeError(
          `[stitchkit] ${caller}: every runtimeWorkspaceRoots entry must be a non-empty string`,
        );
      }
    }
  }
  if (overrides.config !== undefined) {
    if (
      typeof overrides.config !== 'object' ||
      overrides.config === null ||
      Array.isArray(overrides.config)
    ) {
      throw new TypeError(`[stitchkit] ${caller}: config must be a plain JSON object`);
    }
    safeJsonValue(overrides.config);
  }
}

/** Build JSON-RPC params for `thread/start`, `thread/resume`, or `thread/fork` from merged policy fields. */
export function buildCodexThreadPolicyParams(
  base: CodexThreadPolicyOverrides,
  overrides: CodexThreadPolicyOverrides | undefined,
): Record<string, JsonRpcValue> {
  const mergedConfig =
    base.config !== undefined || overrides?.config !== undefined
      ? { ...(base.config ?? {}), ...(overrides?.config ?? {}) }
      : undefined;
  const merged: CodexThreadPolicyOverrides = {
    ...base,
    ...overrides,
    ...(mergedConfig !== undefined && { config: mergedConfig }),
  };
  validateCodexPolicyOverrides(merged, 'CodexSession');
  const params: Record<string, JsonRpcValue> = {};
  if (merged.model !== undefined) params.model = merged.model;
  if (merged.modelProvider !== undefined) params.modelProvider = merged.modelProvider;
  if (merged.approvalPolicy !== undefined)
    params.approvalPolicy = safeJsonValue(merged.approvalPolicy);
  if (merged.sandbox !== undefined) params.sandbox = merged.sandbox;
  if (merged.developerInstructions !== undefined)
    params.developerInstructions = merged.developerInstructions;
  if (merged.runtimeWorkspaceRoots !== undefined)
    params.runtimeWorkspaceRoots = [...merged.runtimeWorkspaceRoots];
  if (merged.config !== undefined) params.config = safeJsonValue(merged.config);
  return params;
}

/** Validate per-turn overrides eagerly before host image files are read. */
export function validateCodexTurnStartOverrides(
  turnInput: CodexTurnInput,
  activeModelProvider: string | undefined,
): void {
  if (turnInput.modelProvider !== undefined) {
    if (activeModelProvider === undefined || turnInput.modelProvider !== activeModelProvider) {
      throw new TypeError(
        `Codex turn/start cannot switch modelProvider to ${JSON.stringify(turnInput.modelProvider)} (thread active provider is ${JSON.stringify(activeModelProvider ?? 'unknown')})`,
      );
    }
  }
  if (turnInput.collaborationMode !== undefined) {
    CodexCollaborationModeSchema.parse(turnInput.collaborationMode);
  }
  if (turnInput.approvalPolicy !== undefined) {
    safeJsonValue(turnInput.approvalPolicy);
  }
  if (turnInput.sandboxPolicy !== undefined) {
    safeJsonValue(turnInput.sandboxPolicy);
  }
  if (turnInput.runtimeWorkspaceRoots !== undefined) {
    validateCodexPolicyOverrides(
      { runtimeWorkspaceRoots: turnInput.runtimeWorkspaceRoots },
      'CodexSession.startTurn',
    );
  }
}

/** Build validated `turn/start` RPC parameters from turn input and inlined parts. */
export function buildCodexTurnStartParams(
  threadId: string,
  turnInput: CodexTurnInput,
  parts: readonly InlinedPart[],
  activeModelProvider: string | undefined,
): Record<string, JsonRpcValue> {
  validateCodexTurnStartOverrides(turnInput, activeModelProvider);
  const params: Record<string, JsonRpcValue> = {
    threadId,
    input: codexTurnInput(parts),
    clientUserMessageId: turnInput.clientId,
  };
  if (turnInput.model !== undefined) params.model = turnInput.model;
  if (turnInput.reasoningEffort !== undefined) params.effort = turnInput.reasoningEffort;
  if (turnInput.collaborationMode !== undefined) {
    params.collaborationMode = CodexCollaborationModeSchema.parse(turnInput.collaborationMode);
  }
  if (turnInput.approvalPolicy !== undefined) {
    params.approvalPolicy = safeJsonValue(turnInput.approvalPolicy);
  }
  if (turnInput.sandboxPolicy !== undefined) {
    params.sandboxPolicy = safeJsonValue(turnInput.sandboxPolicy);
  }
  if (turnInput.runtimeWorkspaceRoots !== undefined) {
    params.runtimeWorkspaceRoots = [...turnInput.runtimeWorkspaceRoots];
  }
  return params;
}

/** Create the read/inspection control facade backed by an active Codex JSON-RPC peer. */
export function createCodexControlClient(input: {
  peer: JsonRpcPeer;
  ensureAlive(): void;
}): CodexControlClient {
  const call = async (
    method: string,
    params?: Record<string, JsonRpcValue>,
  ): Promise<JsonRpcValue> => {
    input.ensureAlive();
    return input.peer.request(method, params);
  };
  return {
    readConfig(params) {
      return call('config/read', {
        ...(params?.cwd !== undefined && { cwd: params.cwd }),
        ...(params?.includeLayers !== undefined && { includeLayers: params.includeLayers }),
      });
    },
    listMcpServerStatus(params) {
      return call('mcpServerStatus/list', {
        ...(params?.cursor !== undefined && { cursor: params.cursor }),
        ...(params?.limit !== undefined && { limit: params.limit }),
        ...(params?.threadId !== undefined && { threadId: params.threadId }),
        ...(params?.serverName !== undefined && { serverName: params.serverName }),
        ...(params?.detail !== undefined && { detail: params.detail }),
      });
    },
    listSkills(params) {
      return call('skills/list', {
        ...(params?.cwds !== undefined && { cwds: [...params.cwds] }),
        ...(params?.forceReload !== undefined && { forceReload: params.forceReload }),
      });
    },
    listModels(params) {
      return call('model/list', {
        ...(params?.cursor !== undefined && { cursor: params.cursor }),
        ...(params?.limit !== undefined && { limit: params.limit }),
        ...(params?.includeHidden !== undefined && { includeHidden: params.includeHidden }),
        ...(params?.modelProvider !== undefined && { modelProvider: params.modelProvider }),
      });
    },
    readAccount(params) {
      return call('account/read', {
        ...(params?.refreshToken !== undefined && { refreshToken: params.refreshToken }),
      });
    },
    readRateLimits() {
      return call('account/rateLimits/read');
    },
  };
}

/** Create thread/turn control methods (`steerTurn`, `forkThread`, `compactThread`) for a live Codex session. */
export function createCodexSessionMutators(input: {
  peer: JsonRpcPeer;
  threadId: string;
  imageOptions: DriverImageOptions;
  signal: AbortSignal;
  ensureAlive(): void;
  getActiveTurn(): { readonly codexTurnId?: string } | undefined;
}) {
  return {
    async steerTurn(steerInput: CodexSteerTurnInput): Promise<{ readonly turnId: string }> {
      input.ensureAlive();
      const active = input.getActiveTurn();
      const expectedTurnId = active?.codexTurnId;
      if (active === undefined || expectedTurnId === undefined) {
        throw new Error('Cannot steer turn: no Codex turn is currently running');
      }
      if (
        steerInput.expectedTurnId !== undefined &&
        steerInput.expectedTurnId !== expectedTurnId
      ) {
        throw new TypeError(
          `Expected active Codex turn ${steerInput.expectedTurnId}, but current turn is ${expectedTurnId}`,
        );
      }
      const parts = await inlineParts(steerInput.input, {
        ...input.imageOptions,
        driverLabel: 'The Codex driver',
        signal: input.signal,
      });
      input.ensureAlive();
      const afterAwait = input.getActiveTurn();
      if (afterAwait !== active || afterAwait.codexTurnId !== expectedTurnId) {
        throw new Error(
          'Cannot steer turn: the active Codex turn ended before steering was sent',
        );
      }
      const steered = CodexTurnSteerResponseSchema.parse(
        await input.peer.request('turn/steer', {
          threadId: input.threadId,
          expectedTurnId,
          input: codexTurnInput(parts),
          ...(steerInput.clientId !== undefined && {
            clientUserMessageId: steerInput.clientId,
          }),
        }),
      );
      return { turnId: steered.turnId };
    },
    async forkThread(options: CodexForkThreadOptions = {}): Promise<CodexForkedThread> {
      input.ensureAlive();
      const policyParams = buildCodexThreadPolicyParams({}, options);
      const forked = CodexStartedThreadSchema.parse(
        await input.peer.request('thread/fork', {
          threadId: input.threadId,
          ...policyParams,
          ...(options.cwd !== undefined && { cwd: options.cwd }),
          ...(options.beforeTurnId !== undefined && { beforeTurnId: options.beforeTurnId }),
          ...(options.lastTurnId !== undefined && { lastTurnId: options.lastTurnId }),
          ...(options.excludeTurns !== undefined && { excludeTurns: options.excludeTurns }),
        }),
      );
      return {
        nativeThreadId: forked.thread.id,
        threadContext: extractCodexThreadContext(forked),
      };
    },
    async compactThread(): Promise<void> {
      input.ensureAlive();
      await input.peer.request('thread/compact/start', { threadId: input.threadId });
    },
  };
}
