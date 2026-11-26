import type { AgentEngineDriver, AgentEngineSession, AgentEngineTurn } from '../engine';
import type { InteractionReply } from '../executor-contract';
import type { ExecutorDriverCapabilities } from '../hello';
import type { DriverImageOptions } from '../image-input';
import type { JsonRpcPeer, JsonRpcValue } from '../json-rpc-peer';
import type { ExecutorProfileConfig } from '../profile';
import { safeJsonValue } from '../session-primitives';
import type { ExecutorStartupPhase } from '../vocabulary';
import type {
  CodexControlClient,
  CodexControlConnectInput,
  CodexControlConnection,
  CodexListItemsParams,
  CodexListTurnsParams,
  CodexReadThreadParams,
} from './control-client';
import {
  type CodexApprovalPolicy,
  type CodexCollaborationMode,
  CodexCollaborationModeSchema,
  type CodexSandboxMode,
  CodexStartedThreadSchema,
  type CodexThreadContext,
  extractCodexThreadContext,
} from './protocol';
import type { CodexSharedServer, CodexSharedServerOpenInput } from './shared-server';
import {
  assertNonEmptyThreadId,
  assertOptionalNonEmptyNoNulString,
  assertOptionalNonEmptyString,
  assertRequiredNonEmptyString,
  type CodexInjectItemsParams,
  type CodexInterruptTurnParams,
  type CodexRevertThreadParams,
  type CodexRevertThreadResult,
  type CodexSetThreadNameParams,
  type CodexUpdateThreadMetadataParams,
} from './thread-controls';
import type { CodexResumeThreadParams } from './thread-open';
import {
  type CodexTurnInputPart,
  codexTurnInput,
  type InlinedCodexPart,
  inlineCodexParts,
  sendCodexTurnSteer,
} from './turn-input';

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

/** Input to {@link CodexSession.startTurn}, extending the portable turn input with Codex per-turn overrides, `localImage`, and `skill` items. */
export interface CodexTurnInput {
  readonly turnId: string;
  readonly clientId: string;
  readonly input: readonly CodexTurnInputPart[];
  /** Per-turn working directory override forwarded on `turn/start`. */
  readonly cwd?: string;
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

/** Codex turn handle returned by {@link CodexSession.startTurn}, exposing the server-assigned `nativeTurnId`. */
export interface CodexTurn extends AgentEngineTurn {
  /** Native turn identifier assigned by Codex in the `turn/start` response (`turn.id`). */
  readonly nativeTurnId: string;
}

/** Input to {@link CodexSession.steerTurn} (`turn/steer`). */
export interface CodexSteerTurnInput {
  readonly input: readonly CodexTurnInputPart[];
  readonly clientId?: string;
  /** Active Codex turn id guard; required when steering an external/TUI turn without a local `startTurn()`. */
  readonly expectedTurnId?: string;
}

/** Options for {@link CodexSession.forkThread} (`thread/fork`). */
export interface CodexForkThreadOptions extends CodexThreadPolicyOverrides {
  readonly cwd?: string;
  readonly beforeTurnId?: string;
  readonly lastTurnId?: string;
  readonly excludeTurns?: boolean;
  /** Carry the source thread's goal into the fork without starting automatic continuation. */
  readonly deferGoalContinuation?: boolean;
}

/** Options to open a new {@link CodexSession} directly via `thread/fork` instead of `thread/start`. */
export interface CodexOpenForkOptions extends CodexThreadPolicyOverrides {
  /** Existing thread id to fork from. */
  readonly threadId: string;
  readonly beforeTurnId?: string;
  readonly lastTurnId?: string;
  /** Defaults to `true` when omitted so large threads do not inline full history into the fork reply. */
  readonly excludeTurns?: boolean;
  /** Carry the source thread's goal into the fork without starting automatic continuation. */
  readonly deferGoalContinuation?: boolean;
}

/** Input to {@link CodexDriver.open}, extending {@link AgentEngineDriver.open} with `forkFrom`. */
export interface CodexOpenInput {
  readonly profile: ExecutorProfileConfig;
  readonly cwd: string;
  /** Resume this native thread via `thread/resume` (mutually exclusive with `forkFrom`). */
  readonly nativeThreadId?: string;
  /** Open the session by forking an existing thread via `thread/fork` (mutually exclusive with `nativeThreadId`). */
  readonly forkFrom?: CodexOpenForkOptions;
  /** Optional observer invoked with startup phases (`spawning`, `initializing`, `verifying`) during open. */
  readonly onStartupPhase?: (phase: ExecutorStartupPhase) => void;
  readonly signal?: AbortSignal;
}

/** Result returned by {@link CodexSession.forkThread} without mutating the current session. */
export interface CodexForkedThread {
  readonly nativeThreadId: string;
  readonly threadContext: CodexThreadContext;
}

/** Extended Codex session handle exposing `providerPid`, `userAgent`, applied `threadContext`, and live app-server controls. */
export interface CodexSession extends AgentEngineSession, CodexControlClient {
  /** OS process id of the spawned `codex app-server`, or `undefined` when attached via `unix-connect`. */
  readonly providerPid: number | undefined;
  /** Server-reported `userAgent` from the `initialize` response, or `undefined` when omitted. */
  readonly userAgent: string | undefined;
  /** Applied thread settings reported by `thread/start`, `thread/resume`, or `thread/fork`. */
  readonly threadContext: CodexThreadContext;
  /** Start a turn with optional per-turn Codex overrides, `localImage`, and `skill` items; resolves with `nativeTurnId`. */
  startTurn(input: CodexTurnInput): Promise<CodexTurn>;
  /** Answer a pending request from either the active turn or an external/TUI server request. */
  respond(interactionId: string, reply: InteractionReply['reply']): Promise<void>;
  /** Read thread metadata (`thread/read`); defaults `threadId` to this session's `nativeThreadId`. */
  readThread(
    params?: Omit<CodexReadThreadParams, 'threadId'> & { readonly threadId?: string },
  ): Promise<JsonRpcValue>;
  /** List turns (`thread/turns/list`); defaults `threadId` to this session's `nativeThreadId`. */
  listTurns(
    params?: Omit<CodexListTurnsParams, 'threadId'> & { readonly threadId?: string },
  ): Promise<JsonRpcValue>;
  /** List items (`thread/items/list`); defaults `threadId` to this session's `nativeThreadId`. */
  listItems(
    params?: Omit<CodexListItemsParams, 'threadId'> & { readonly threadId?: string },
  ): Promise<JsonRpcValue>;
  /** Resume a thread (`thread/resume`, defaulting `excludeTurns` to `true`); defaults `threadId` to `nativeThreadId` and does not mutate cached `threadContext`. */
  resumeThread(
    params?: Omit<CodexResumeThreadParams, 'threadId'> & { readonly threadId?: string },
  ): Promise<JsonRpcValue>;
  /** Revert thread durable history before `beforeTurnId` (`thread/revert`); defaults `threadId` to `nativeThreadId`. */
  revertThread(
    params: Omit<CodexRevertThreadParams, 'threadId'> & { readonly threadId?: string },
  ): Promise<CodexRevertThreadResult>;
  /** Inject raw Responses API items (`thread/inject_items`); defaults `threadId` to `nativeThreadId`. */
  injectItems(
    params: Omit<CodexInjectItemsParams, 'threadId'> & { readonly threadId?: string },
  ): Promise<JsonRpcValue>;
  /** Unsubscribe this connection (`thread/unsubscribe`); defaults `threadId` to `nativeThreadId`. */
  unsubscribeThread(params?: { readonly threadId?: string }): Promise<JsonRpcValue>;
  /** Archive a thread (`thread/archive`); defaults `threadId` to `nativeThreadId`. */
  archiveThread(params?: { readonly threadId?: string }): Promise<JsonRpcValue>;
  /** Unarchive a thread (`thread/unarchive`); defaults `threadId` to `nativeThreadId`. */
  unarchiveThread(params?: { readonly threadId?: string }): Promise<JsonRpcValue>;
  /** Patch thread metadata (`thread/metadata/update`); defaults `threadId` to `nativeThreadId`. */
  updateThreadMetadata(
    params?: Omit<CodexUpdateThreadMetadataParams, 'threadId'> & {
      readonly threadId?: string;
    },
  ): Promise<JsonRpcValue>;
  /** Set thread display name (`thread/name/set`); defaults `threadId` to `nativeThreadId`. */
  setThreadName(
    params: Omit<CodexSetThreadNameParams, 'threadId'> & { readonly threadId?: string },
  ): Promise<JsonRpcValue>;
  /** Interrupt a running turn (`turn/interrupt`), including external/TUI or reconnected turns; defaults `threadId` to `nativeThreadId`. */
  interruptTurn(
    params: Omit<CodexInterruptTurnParams, 'threadId'> & { readonly threadId?: string },
  ): Promise<void>;
  /** Steer an active turn with additional input (`turn/steer`); accepts explicit `expectedTurnId` for external/TUI turns and optional `threadId`. */
  steerTurn(
    input: CodexSteerTurnInput & { readonly threadId?: string },
  ): Promise<{ readonly turnId: string }>;
  /** Fork the session's thread into a new thread id without mutating the current session (`thread/fork`). */
  forkThread(options?: CodexForkThreadOptions): Promise<CodexForkedThread>;
  /** Request context compaction (`thread/compact/start`); defaults `threadId` to `nativeThreadId`. */
  compactThread(params?: { readonly threadId?: string }): Promise<void>;
}

/** Codex driver returned by {@link createCodexDriver}; `open()` resolves to {@link CodexSession} and `connectControl()` opens a threadless control link. */
export interface CodexDriver extends AgentEngineDriver {
  readonly engine: 'codex';
  readonly reconcile: 'client-id';
  readonly capabilities: ExecutorDriverCapabilities;
  findInput: NonNullable<AgentEngineDriver['findInput']>;
  open(input: CodexOpenInput): Promise<CodexSession>;
  /** Connect to `codex app-server` without starting, resuming, or forking a thread. */
  connectControl(input: CodexControlConnectInput): Promise<CodexControlConnection>;
  /** Open a shared headless `stdio` `codex app-server` multiplexing multiple threads (ADR 0329). */
  openSharedServer(input: CodexSharedServerOpenInput): Promise<CodexSharedServer>;
}

/** Validate `beforeTurnId` and `lastTurnId` mutual exclusion for `thread/fork`. */
export function validateCodexForkBounds(
  options: Pick<CodexForkThreadOptions, 'beforeTurnId' | 'lastTurnId'>,
  caller: string,
): void {
  if (options.beforeTurnId !== undefined && options.lastTurnId !== undefined) {
    throw new TypeError(
      `[stitchkit] ${caller}: beforeTurnId and lastTurnId are mutually exclusive`,
    );
  }
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
  assertOptionalNonEmptyNoNulString(turnInput.cwd, 'cwd', 'CodexSession.startTurn');
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
  parts: readonly InlinedCodexPart[],
  activeModelProvider: string | undefined,
): Record<string, JsonRpcValue> {
  validateCodexTurnStartOverrides(turnInput, activeModelProvider);
  const params: Record<string, JsonRpcValue> = {
    threadId,
    input: codexTurnInput(parts),
    clientUserMessageId: turnInput.clientId,
  };
  if (turnInput.cwd !== undefined) params.cwd = turnInput.cwd;
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

/** Create session-bound turn/thread mutators (`steerTurn`, `forkThread`) for a live Codex session. */
export function createCodexSessionMutators(input: {
  peer: JsonRpcPeer;
  threadId: string;
  imageOptions: DriverImageOptions;
  signal: AbortSignal;
  ensureAlive(): void;
  getActiveTurn(): { readonly codexTurnId?: string } | undefined;
}) {
  return {
    async steerTurn(
      steerInput: CodexSteerTurnInput & { readonly threadId?: string },
    ): Promise<{ readonly turnId: string }> {
      input.ensureAlive();
      const caller = 'CodexSession.steerTurn';
      const targetThreadId =
        steerInput.threadId === undefined
          ? input.threadId
          : assertNonEmptyThreadId(steerInput.threadId, caller);
      assertOptionalNonEmptyString(steerInput.clientId, 'clientId', caller);
      assertOptionalNonEmptyString(steerInput.expectedTurnId, 'expectedTurnId', caller);
      if (targetThreadId !== input.threadId) {
        const expectedTurnId = assertRequiredNonEmptyString(
          steerInput.expectedTurnId,
          'expectedTurnId',
          caller,
        );
        const parts = await inlineCodexParts(steerInput.input, {
          ...input.imageOptions,
          driverLabel: 'The Codex driver',
          signal: input.signal,
        });
        input.ensureAlive();
        return sendCodexTurnSteer(input.peer, {
          threadId: targetThreadId,
          expectedTurnId,
          parts,
          ...(steerInput.clientId !== undefined && { clientId: steerInput.clientId }),
        });
      }
      const active = input.getActiveTurn();
      let expectedTurnId: string;
      if (active !== undefined) {
        if (active.codexTurnId === undefined) {
          throw new Error('Cannot steer turn: no Codex turn is currently running');
        }
        if (
          steerInput.expectedTurnId !== undefined &&
          steerInput.expectedTurnId !== active.codexTurnId
        ) {
          throw new TypeError(
            `Expected active Codex turn ${steerInput.expectedTurnId}, but current turn is ${active.codexTurnId}`,
          );
        }
        expectedTurnId = active.codexTurnId;
      } else {
        if (steerInput.expectedTurnId === undefined) {
          throw new Error('Cannot steer turn: no Codex turn is currently running');
        }
        expectedTurnId = steerInput.expectedTurnId;
      }
      const parts = await inlineCodexParts(steerInput.input, {
        ...input.imageOptions,
        driverLabel: 'The Codex driver',
        signal: input.signal,
      });
      input.ensureAlive();
      const afterAwait = input.getActiveTurn();
      if (active !== undefined) {
        if (afterAwait !== active || afterAwait.codexTurnId !== expectedTurnId) {
          throw new Error(
            'Cannot steer turn: the active Codex turn ended before steering was sent',
          );
        }
      } else if (afterAwait !== undefined && afterAwait.codexTurnId !== expectedTurnId) {
        throw new TypeError(
          `Expected active Codex turn ${expectedTurnId}, but current turn is ${afterAwait.codexTurnId ?? 'starting'}`,
        );
      }
      return sendCodexTurnSteer(input.peer, {
        threadId: input.threadId,
        expectedTurnId,
        parts,
        ...(steerInput.clientId !== undefined && { clientId: steerInput.clientId }),
      });
    },
    async forkThread(options: CodexForkThreadOptions = {}): Promise<CodexForkedThread> {
      input.ensureAlive();
      validateCodexForkBounds(options, 'CodexSession.forkThread');
      const policyParams = buildCodexThreadPolicyParams({}, options);
      const forked = CodexStartedThreadSchema.parse(
        await input.peer.request('thread/fork', {
          threadId: input.threadId,
          ...policyParams,
          ...(options.cwd !== undefined && { cwd: options.cwd }),
          ...(options.beforeTurnId !== undefined && { beforeTurnId: options.beforeTurnId }),
          ...(options.lastTurnId !== undefined && { lastTurnId: options.lastTurnId }),
          ...(options.excludeTurns !== undefined && { excludeTurns: options.excludeTurns }),
          ...(options.deferGoalContinuation !== undefined && {
            deferGoalContinuation: options.deferGoalContinuation,
          }),
        }),
      );
      return {
        nativeThreadId: forked.thread.id,
        threadContext: extractCodexThreadContext(forked),
      };
    },
  };
}
