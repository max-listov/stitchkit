import type { AgentEngineDriver, AgentEngineSession, AgentEngineTurn } from '../engine';
import type { InteractionReply } from '../executor-contract';
import type { ExecutorDriverCapabilities } from '../hello';
import type { JsonRpcValue } from '../json-rpc-peer';
import type { ExecutorProfileConfig } from '../profile';
import type { ExecutorStartupPhase } from '../vocabulary';
import type {
  CodexControlClient,
  CodexControlConnectInput,
  CodexControlConnection,
  CodexListItemsParams,
  CodexListTurnsParams,
  CodexReadThreadParams,
} from './control-client';
import type {
  CodexApprovalPolicy,
  CodexCollaborationMode,
  CodexSandboxMode,
  CodexSandboxPolicy,
  CodexThreadContext,
  CodexTurnsPage,
} from './protocol';
import type {
  CodexItemsPage,
  CodexReadThreadResponse,
  CodexResumeThreadResponse,
  CodexThreadMetadataUpdateResponse,
  CodexThreadUnarchiveResponse,
  CodexThreadUnsubscribeResponse,
} from './responses';
import type { CodexSharedServer, CodexSharedServerOpenInput } from './shared-server';
import type {
  CodexInjectItemsParams,
  CodexInterruptTurnParams,
  CodexRevertThreadParams,
  CodexRevertThreadResult,
  CodexRpcCallOptions,
  CodexSetThreadNameParams,
  CodexUpdateThreadMetadataParams,
} from './thread-controls';
import type { CodexResumeThreadParams } from './thread-open';
import type { CodexTurnInputPart } from './turn-input';

/** Policy and configuration fields forwarded to Codex `thread/start`, `thread/resume`, and `thread/fork`. */
export interface CodexThreadPolicyOverrides {
  /** Model identifier to use for the thread. */
  readonly model?: string | undefined;
  /** Model provider identifier (for example `openai`). */
  readonly modelProvider?: string | undefined;
  /** Approval policy applied to the thread. */
  readonly approvalPolicy?: CodexApprovalPolicy | undefined;
  /** Sandbox mode applied to the thread. */
  readonly sandbox?: CodexSandboxMode | undefined;
  /** Developer instructions appended to the thread system context. */
  readonly developerInstructions?: string | undefined;
  /** Additional workspace roots allowed for runtime filesystem access. */
  readonly runtimeWorkspaceRoots?: readonly string[] | undefined;
  /** Codex app-server config overrides for the thread (sandbox writable roots, disabled MCP/plugins/features, network policy). */
  readonly config?: Readonly<Record<string, JsonRpcValue>> | undefined;
}

/** Input to {@link CodexSession.startTurn}, extending the portable turn input with Codex per-turn overrides, `localImage`, and `skill` items. */
export interface CodexTurnInput {
  readonly turnId: string;
  readonly clientId: string;
  readonly input: readonly CodexTurnInputPart[];
  /** Per-turn working directory override forwarded on `turn/start`. */
  readonly cwd?: string | undefined;
  /** Per-turn model override forwarded on `turn/start`. */
  readonly model?: string | undefined;
  /**
   * Verified fail-closed against the thread's active `modelProvider`; Codex's `turn/start`
   * does not switch providers mid-thread.
   */
  readonly modelProvider?: string | undefined;
  /** Per-turn reasoning effort override (forwarded to Codex as `effort`). */
  readonly reasoningEffort?: string | undefined;
  /** Per-turn collaboration mode override (`plan` or `default`). */
  readonly collaborationMode?: CodexCollaborationMode | undefined;
  /** Per-turn approval policy override. */
  readonly approvalPolicy?: CodexApprovalPolicy | undefined;
  /** Per-turn sandbox policy object override (`sandboxPolicy`). */
  readonly sandboxPolicy?: CodexSandboxPolicy | undefined;
  /** Per-turn runtime workspace roots override. */
  readonly runtimeWorkspaceRoots?: readonly string[] | undefined;
}

/** Codex turn handle returned by {@link CodexSession.startTurn}, exposing the server-assigned `nativeTurnId`. */
export interface CodexTurn extends AgentEngineTurn {
  /** Native turn identifier assigned by Codex in the `turn/start` response (`turn.id`). */
  readonly nativeTurnId: string;
}

/** Input to {@link CodexSession.steerTurn} (`turn/steer`). */
export interface CodexSteerTurnInput {
  readonly input: readonly CodexTurnInputPart[];
  readonly clientId?: string | undefined;
  /** Active Codex turn id guard; required when steering an external/TUI turn without a local `startTurn()`. */
  readonly expectedTurnId?: string | undefined;
}

/** Options for {@link CodexSession.forkThread} (`thread/fork`). */
export interface CodexForkThreadOptions extends CodexThreadPolicyOverrides {
  readonly cwd?: string | undefined;
  readonly beforeTurnId?: string | undefined;
  readonly lastTurnId?: string | undefined;
  readonly excludeTurns?: boolean | undefined;
  /** Carry the source thread's goal into the fork without starting automatic continuation. */
  readonly deferGoalContinuation?: boolean | undefined;
}

/** Options to open a new {@link CodexSession} directly via `thread/fork` instead of `thread/start`. */
export interface CodexOpenForkOptions extends CodexThreadPolicyOverrides {
  /** Existing thread id to fork from. */
  readonly threadId: string;
  readonly beforeTurnId?: string | undefined;
  readonly lastTurnId?: string | undefined;
  /** Defaults to `true` when omitted so large threads do not inline full history into the fork reply. */
  readonly excludeTurns?: boolean | undefined;
  /** Carry the source thread's goal into the fork without starting automatic continuation. */
  readonly deferGoalContinuation?: boolean | undefined;
}

/** Input to {@link CodexDriver.open}, extending {@link AgentEngineDriver.open} with `forkFrom`. */
export interface CodexOpenInput {
  readonly profile: ExecutorProfileConfig;
  readonly cwd: string;
  /** Resume this native thread via `thread/resume` (mutually exclusive with `forkFrom`). */
  readonly nativeThreadId?: string | undefined;
  /** Open the session by forking an existing thread via `thread/fork` (mutually exclusive with `nativeThreadId`). */
  readonly forkFrom?: CodexOpenForkOptions | undefined;
  /** Optional observer invoked with startup phases (`spawning`, `initializing`, `verifying`) during open. */
  readonly onStartupPhase?: ((phase: ExecutorStartupPhase) => void) | undefined;
  readonly signal?: AbortSignal | undefined;
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
    params?: Omit<CodexReadThreadParams, 'threadId'> & {
      readonly threadId?: string | undefined;
    },
    options?: CodexRpcCallOptions,
  ): Promise<CodexReadThreadResponse>;
  /** List turns (`thread/turns/list`); defaults `threadId` to this session's `nativeThreadId`. */
  listTurns(
    params?: Omit<CodexListTurnsParams, 'threadId'> & {
      readonly threadId?: string | undefined;
    },
    options?: CodexRpcCallOptions,
  ): Promise<CodexTurnsPage>;
  /** List items (`thread/items/list`); defaults `threadId` to this session's `nativeThreadId`. */
  listItems(
    params?: Omit<CodexListItemsParams, 'threadId'> & {
      readonly threadId?: string | undefined;
    },
    options?: CodexRpcCallOptions,
  ): Promise<CodexItemsPage>;
  /** Resume a thread (`thread/resume`, defaulting `excludeTurns` to `true`); defaults `threadId` to `nativeThreadId` and does not mutate cached `threadContext`. */
  resumeThread(
    params?: Omit<CodexResumeThreadParams, 'threadId'> & {
      readonly threadId?: string | undefined;
    },
    options?: CodexRpcCallOptions,
  ): Promise<CodexResumeThreadResponse>;
  /** Revert thread durable history before `beforeTurnId` (`thread/revert`); defaults `threadId` to `nativeThreadId`. */
  revertThread(
    params: Omit<CodexRevertThreadParams, 'threadId'> & {
      readonly threadId?: string | undefined;
    },
    options?: CodexRpcCallOptions,
  ): Promise<CodexRevertThreadResult>;
  /** Inject raw Responses API items (`thread/inject_items`); defaults `threadId` to `nativeThreadId`. */
  injectItems(
    params: Omit<CodexInjectItemsParams, 'threadId'> & {
      readonly threadId?: string | undefined;
    },
    options?: CodexRpcCallOptions,
  ): Promise<void>;
  /**
   * Unsubscribe this connection from a thread the driver did not open (`thread/unsubscribe`). Rejects
   * with `TypeError` for this session's own thread (the default) and for any thread open on the same
   * shared server: detach those with `close()`.
   */
  unsubscribeThread(
    params?: { readonly threadId?: string | undefined },
    options?: CodexRpcCallOptions,
  ): Promise<CodexThreadUnsubscribeResponse>;
  /** Archive a thread (`thread/archive`); defaults `threadId` to `nativeThreadId`. */
  archiveThread(
    params?: { readonly threadId?: string | undefined },
    options?: CodexRpcCallOptions,
  ): Promise<void>;
  /** Unarchive a thread (`thread/unarchive`); defaults `threadId` to `nativeThreadId`. */
  unarchiveThread(
    params?: { readonly threadId?: string | undefined },
    options?: CodexRpcCallOptions,
  ): Promise<CodexThreadUnarchiveResponse>;
  /** Patch thread metadata (`thread/metadata/update`); defaults `threadId` to `nativeThreadId`. */
  updateThreadMetadata(
    params?: Omit<CodexUpdateThreadMetadataParams, 'threadId'> & {
      readonly threadId?: string | undefined;
    },
    options?: CodexRpcCallOptions,
  ): Promise<CodexThreadMetadataUpdateResponse>;
  /** Set thread display name (`thread/name/set`); defaults `threadId` to `nativeThreadId`. */
  setThreadName(
    params: Omit<CodexSetThreadNameParams, 'threadId'> & {
      readonly threadId?: string | undefined;
    },
    options?: CodexRpcCallOptions,
  ): Promise<void>;
  /** Interrupt a running turn (`turn/interrupt`), including external/TUI or reconnected turns; defaults `threadId` to `nativeThreadId`. */
  interruptTurn(
    params: Omit<CodexInterruptTurnParams, 'threadId'> & {
      readonly threadId?: string | undefined;
    },
    options?: CodexRpcCallOptions,
  ): Promise<void>;
  /** Steer an active turn with additional input (`turn/steer`); accepts explicit `expectedTurnId` for external/TUI turns and optional `threadId`. */
  steerTurn(
    input: CodexSteerTurnInput & { readonly threadId?: string | undefined },
    options?: CodexRpcCallOptions,
  ): Promise<{ readonly turnId: string }>;
  /** Fork the session's thread into a new thread id without mutating the current session (`thread/fork`). */
  forkThread(
    options?: CodexForkThreadOptions,
    rpcOptions?: CodexRpcCallOptions,
  ): Promise<CodexForkedThread>;
  /** Request context compaction (`thread/compact/start`); defaults `threadId` to `nativeThreadId`. */
  compactThread(
    params?: { readonly threadId?: string | undefined },
    options?: CodexRpcCallOptions,
  ): Promise<void>;
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
