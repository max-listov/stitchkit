import { withLinkedAbortSignals } from '../../internal/abort-race';
import type { InteractionReply } from '../executor-contract';
import type { DriverImageOptions } from '../image-input';
import type { JsonRpcPeer, JsonRpcValue } from '../json-rpc-peer';
import type { ExecutorProfileConfig } from '../profile';
import type { ExecutorStartupPhase } from '../vocabulary';
import { createCodexReadMethods } from './control-read-methods';
import {
  type CodexApprovalPolicy,
  type CodexCollaborationMode,
  type CodexSandboxPolicy,
  CodexStartedTurnSchema,
  type CodexTurnsPage,
  parseCodexResponse,
} from './protocol';
import {
  type CodexAccountReadResponse,
  type CodexCollaborationModesResponse,
  type CodexConfigReadResponse,
  type CodexItemsPage,
  type CodexLoadedThreadsPage,
  type CodexMcpServerStatusPage,
  type CodexModelsPage,
  type CodexRateLimitsResponse,
  type CodexReadThreadResponse,
  type CodexResumeThreadResponse,
  CodexResumeThreadResponseSchema,
  type CodexSkillsListResponse,
  type CodexThreadMetadataUpdateResponse,
  type CodexThreadsPage,
  type CodexThreadUnarchiveResponse,
  type CodexThreadUnsubscribeResponse,
} from './responses';
import {
  buildCodexTurnStartRpcParams,
  validateCodexTurnStartOverrides,
} from './session-controls';
import {
  assertNonEmptyThreadId,
  assertOptionalNonEmptyString,
  assertRequiredNonEmptyString,
  type CodexInjectItemsParams,
  type CodexInterruptTurnParams,
  type CodexListLoadedThreadsParams,
  type CodexListThreadsParams,
  type CodexRevertThreadParams,
  type CodexRevertThreadResult,
  type CodexRpcCallOptions,
  type CodexSetThreadNameParams,
  type CodexThreadIdParams,
  type CodexUpdateThreadMetadataParams,
  createCodexThreadControlMethods,
  validateCodexRpcCallOptions,
} from './thread-controls';
import { buildCodexResumeThreadParams, type CodexResumeThreadParams } from './thread-open';
import { type CodexTurnInputPart, inlineCodexParts, sendCodexTurnSteer } from './turn-input';

/** Parameters for Codex `thread/read`. */
export interface CodexReadThreadParams {
  /** Thread identifier to inspect. */
  readonly threadId: string;
  /** When `true`, include full rollout turns (deprecated for large threads). */
  readonly includeTurns?: boolean | undefined;
}

/** Parameters for Codex `thread/turns/list`. */
export interface CodexListTurnsParams {
  /** Thread identifier whose turns to list. */
  readonly threadId: string;
  /** Opaque continuation cursor returned by a previous page, or `null` for the first page. */
  readonly cursor?: string | null | undefined;
  /** Optional page size (`uint32`). */
  readonly limit?: number | undefined;
  /** Level of item detail per turn (`notLoaded`, `summary`, or `full`). */
  readonly itemsView?: 'notLoaded' | 'summary' | 'full' | undefined;
  /** Pagination direction (`asc` or `desc`). */
  readonly sortDirection?: 'asc' | 'desc' | undefined;
}

/** Starting position for a `thread/items/list` page: opaque string cursor or exclusive item anchor. */
export type CodexThreadItemsCursor =
  | string
  | { readonly type: 'item'; readonly itemId: string };

/** Output deferral preferences accepted by Codex `thread/items/list`. */
export interface CodexThreadItemsDeferOutput {
  /** Defer nonempty output from successful commands. */
  readonly commandExecution?: boolean | undefined;
  /** Defer nonempty plain-text results from successful MCP tool calls. */
  readonly mcpToolCall?: boolean | undefined;
}

/** Parameters for Codex `thread/items/list`. */
export interface CodexListItemsParams {
  /** Thread identifier whose items to list. */
  readonly threadId: string;
  /** Optional turn identifier to filter items to one turn. */
  readonly turnId?: string | undefined;
  /** Opaque continuation cursor, exclusive item anchor within `turnId`, or `null` for the first page. */
  readonly cursor?: CodexThreadItemsCursor | null | undefined;
  /** Optional page size (`uint32`). */
  readonly limit?: number | undefined;
  /** Pagination direction (`asc` or `desc`). */
  readonly sortDirection?: 'asc' | 'desc' | undefined;
  /** Output deferral flags for single-turn item reads. */
  readonly deferOutput?: CodexThreadItemsDeferOutput | undefined;
}

/** Parameters for steering an active Codex turn on any thread via {@link CodexControlClient.steerTurn} (`turn/steer`). */
export interface CodexControlSteerTurnParams {
  /** Thread identifier owning the active turn to steer. */
  readonly threadId: string;
  /** Required active Codex turn identifier precondition (`expectedTurnId`). */
  readonly expectedTurnId: string;
  /** Ordered turn input parts (text, resolved images, `localImage`, and `skill` items). */
  readonly input: readonly CodexTurnInputPart[];
  /** Optional client-generated idempotency identifier (`clientUserMessageId`). */
  readonly clientId?: string | undefined;
}

/** Parameters for starting a turn on any thread via {@link CodexControlClient.startThreadTurn} (`turn/start`) without occupying a local session turn slot. */
export interface CodexControlStartTurnParams {
  /** Thread identifier on which to start the turn. */
  readonly threadId: string;
  /** Required client-generated idempotency identifier (`clientUserMessageId`). */
  readonly clientId: string;
  /** Ordered turn input parts (text, resolved images, `localImage`, and `skill` items). */
  readonly input: readonly CodexTurnInputPart[];
  /** Optional per-turn working directory override forwarded on `turn/start`. */
  readonly cwd?: string | undefined;
  /** Optional per-turn model override forwarded on `turn/start`. */
  readonly model?: string | undefined;
  /** Optional per-turn reasoning effort override (forwarded to Codex as `effort`). */
  readonly reasoningEffort?: string | undefined;
  /** Optional per-turn collaboration mode override (`plan` or `default`). */
  readonly collaborationMode?: CodexCollaborationMode | undefined;
  /** Optional per-turn approval policy override. */
  readonly approvalPolicy?: CodexApprovalPolicy | undefined;
  /** Optional per-turn sandbox policy override (`sandboxPolicy`). */
  readonly sandboxPolicy?: CodexSandboxPolicy | undefined;
  /** Optional per-turn runtime workspace roots override. */
  readonly runtimeWorkspaceRoots?: readonly string[] | undefined;
}

/** Thread, turn, inspection, and catalog RPCs exposed during thread setup (`prepareThread` / `verifyThread`), on {@link CodexControlConnection}, {@link CodexSharedServer}, and {@link CodexSession}. */
export interface CodexControlClient {
  /** Read effective Codex configuration (`config/read`). */
  readConfig(
    params?: {
      readonly cwd?: string | undefined;
      readonly includeLayers?: boolean | undefined;
    },
    options?: CodexRpcCallOptions,
  ): Promise<CodexConfigReadResponse>;
  /** Read thread metadata and live status (`thread/read`). */
  readThread(
    params: CodexReadThreadParams,
    options?: CodexRpcCallOptions,
  ): Promise<CodexReadThreadResponse>;
  /** List collaboration mode presets (`collaborationMode/list`). */
  listCollaborationModes(
    options?: CodexRpcCallOptions,
  ): Promise<CodexCollaborationModesResponse>;
  /** List turns in a thread (`thread/turns/list`). */
  listTurns(
    params: CodexListTurnsParams,
    options?: CodexRpcCallOptions,
  ): Promise<CodexTurnsPage>;
  /** List items in a thread or single turn (`thread/items/list`). */
  listItems(
    params: CodexListItemsParams,
    options?: CodexRpcCallOptions,
  ): Promise<CodexItemsPage>;
  /** List MCP servers and their statuses (`mcpServerStatus/list`). */
  listMcpServerStatus(
    params?: {
      readonly cursor?: string | undefined;
      readonly limit?: number | undefined;
      readonly threadId?: string | undefined;
      readonly serverName?: string | undefined;
      readonly detail?: string | undefined;
    },
    options?: CodexRpcCallOptions,
  ): Promise<CodexMcpServerStatusPage>;
  /** List discovered Codex skills (`skills/list`). */
  listSkills(
    params?: {
      readonly cwds?: readonly string[] | undefined;
      readonly forceReload?: boolean | undefined;
    },
    options?: CodexRpcCallOptions,
  ): Promise<CodexSkillsListResponse>;
  /** List available models (`model/list`). */
  listModels(
    params?: {
      readonly cursor?: string | undefined;
      readonly limit?: number | undefined;
      readonly includeHidden?: boolean | undefined;
      readonly modelProvider?: string | undefined;
    },
    options?: CodexRpcCallOptions,
  ): Promise<CodexModelsPage>;
  /** Read active account information (`account/read`). */
  readAccount(
    params?: { readonly refreshToken?: boolean | undefined },
    options?: CodexRpcCallOptions,
  ): Promise<CodexAccountReadResponse>;
  /** Read the `account/rateLimits/read` response envelope. */
  readRateLimits(options?: CodexRpcCallOptions): Promise<CodexRateLimitsResponse>;
  /** Revert a thread's durable history to before `beforeTurnId` (`thread/revert`). */
  revertThread(
    params: CodexRevertThreadParams,
    options?: CodexRpcCallOptions,
  ): Promise<CodexRevertThreadResult>;
  /** Append raw Responses API items to a thread's model-visible history (`thread/inject_items`). */
  injectItems(params: CodexInjectItemsParams, options?: CodexRpcCallOptions): Promise<void>;
  /** Unsubscribe this connection from a thread (`thread/unsubscribe`). */
  unsubscribeThread(
    params: CodexThreadIdParams,
    options?: CodexRpcCallOptions,
  ): Promise<CodexThreadUnsubscribeResponse>;
  /** List threads with pagination and bounded filters (`thread/list`). */
  listThreads(
    params?: CodexListThreadsParams,
    options?: CodexRpcCallOptions,
  ): Promise<CodexThreadsPage>;
  /** List thread identifiers currently loaded in memory (`thread/loaded/list`). */
  listLoadedThreads(
    params?: CodexListLoadedThreadsParams,
    options?: CodexRpcCallOptions,
  ): Promise<CodexLoadedThreadsPage>;
  /** Archive a thread (`thread/archive`). */
  archiveThread(params: CodexThreadIdParams, options?: CodexRpcCallOptions): Promise<void>;
  /** Unarchive a thread (`thread/unarchive`). */
  unarchiveThread(
    params: CodexThreadIdParams,
    options?: CodexRpcCallOptions,
  ): Promise<CodexThreadUnarchiveResponse>;
  /** Patch stored metadata (such as Git info) for a thread (`thread/metadata/update`). */
  updateThreadMetadata(
    params: CodexUpdateThreadMetadataParams,
    options?: CodexRpcCallOptions,
  ): Promise<CodexThreadMetadataUpdateResponse>;
  /** Set a thread's display name (`thread/name/set`). */
  setThreadName(
    params: CodexSetThreadNameParams,
    options?: CodexRpcCallOptions,
  ): Promise<void>;
  /** Resume a thread (`thread/resume`, defaulting `excludeTurns` to `true`); returns the typed response without mutating a session's cached `threadContext`. */
  resumeThread(
    params: CodexResumeThreadParams,
    options?: CodexRpcCallOptions,
  ): Promise<CodexResumeThreadResponse>;
  /** Start a turn on any thread via `turn/start` without subscribing to deltas or occupying a local session turn slot. */
  startThreadTurn(
    params: CodexControlStartTurnParams,
    options?: CodexRpcCallOptions,
  ): Promise<{ readonly turnId: string }>;
  /** Interrupt a running turn on a thread (`turn/interrupt`), including external/TUI or reconnected turns. */
  interruptTurn(
    params: CodexInterruptTurnParams,
    options?: CodexRpcCallOptions,
  ): Promise<void>;
  /** Steer an active turn on a thread by explicit `expectedTurnId` (`turn/steer`). */
  steerTurn(
    params: CodexControlSteerTurnParams,
    options?: CodexRpcCallOptions,
  ): Promise<{ readonly turnId: string }>;
  /** Request context compaction for a thread (`thread/compact/start`). */
  compactThread(params: CodexThreadIdParams, options?: CodexRpcCallOptions): Promise<void>;
}

/** Input to {@link CodexDriver.connectControl} for a threadless app-server connection. */
export interface CodexControlConnectInput {
  readonly profile: ExecutorProfileConfig;
  readonly cwd: string;
  /** Optional observer invoked with startup phases (`spawning`, `initializing`) during connect. */
  readonly onStartupPhase?: ((phase: ExecutorStartupPhase) => void) | undefined;
  readonly signal?: AbortSignal | undefined;
}

/** Threadless connection to a Codex app-server for catalog/config reads and external observation. */
export interface CodexControlConnection extends CodexControlClient {
  /** OS process id of the spawned `codex app-server`, or `undefined` when attached via `unix-connect`. */
  readonly providerPid: number | undefined;
  /** Server-reported `userAgent` from the `initialize` response, or `undefined` when omitted. */
  readonly userAgent: string | undefined;
  /** Answer a pending external server request received via `onServerRequest`. */
  respond(interactionId: string, reply: InteractionReply['reply']): Promise<void>;
  /** Close the connection cleanly (does not kill an external server in `unix-connect` mode). */
  close(): Promise<void>;
}

/** Create the read/inspection and turn/thread control facade backed by an active Codex JSON-RPC peer. */
export function createCodexControlClient(input: {
  peer: JsonRpcPeer;
  imageOptions: DriverImageOptions;
  signal: AbortSignal;
  ensureAlive(): void;
  onBeforeInterruptTurn?: (threadId: string, turnId: string) => void;
}): CodexControlClient {
  const call = async (
    method: string,
    params?: Record<string, JsonRpcValue>,
    rpcOptions?: CodexRpcCallOptions,
  ): Promise<JsonRpcValue> => {
    validateCodexRpcCallOptions(rpcOptions);
    input.ensureAlive();
    return input.peer.request(method, params, rpcOptions);
  };
  return {
    ...createCodexReadMethods(call),
    async resumeThread(params, rpcOptions) {
      input.ensureAlive();
      return parseCodexResponse(
        'thread/resume',
        CodexResumeThreadResponseSchema,
        await call('thread/resume', buildCodexResumeThreadParams(params), rpcOptions),
      );
    },
    async startThreadTurn(params, rpcOptions) {
      input.ensureAlive();
      validateCodexRpcCallOptions(rpcOptions);
      const caller = 'CodexControlClient.startThreadTurn';
      const threadId = assertNonEmptyThreadId(params.threadId, caller);
      validateCodexTurnStartOverrides(caller, params);
      const parts = await withLinkedAbortSignals(rpcOptions?.signal, input.signal, (signal) =>
        inlineCodexParts(params.input, {
          ...input.imageOptions,
          driverLabel: 'The Codex driver',
          signal,
        }),
      );
      input.ensureAlive();
      validateCodexRpcCallOptions(rpcOptions);
      const rpcParams = buildCodexTurnStartRpcParams(caller, threadId, params, parts);
      const started = parseCodexResponse(
        'turn/start',
        CodexStartedTurnSchema,
        await call('turn/start', rpcParams, rpcOptions),
      );
      return { turnId: started.turn.id };
    },
    async steerTurn(params, rpcOptions) {
      input.ensureAlive();
      validateCodexRpcCallOptions(rpcOptions);
      const caller = 'CodexControlClient.steerTurn';
      const threadId = assertNonEmptyThreadId(params.threadId, caller);
      const expectedTurnId = assertRequiredNonEmptyString(
        params.expectedTurnId,
        'expectedTurnId',
        caller,
      );
      assertOptionalNonEmptyString(params.clientId, 'clientId', caller);
      const parts = await withLinkedAbortSignals(rpcOptions?.signal, input.signal, (signal) =>
        inlineCodexParts(params.input, {
          ...input.imageOptions,
          driverLabel: 'The Codex driver',
          signal,
        }),
      );
      input.ensureAlive();
      validateCodexRpcCallOptions(rpcOptions);
      return sendCodexTurnSteer(
        input.peer,
        {
          threadId,
          expectedTurnId,
          parts,
          ...(params.clientId !== undefined && { clientId: params.clientId }),
        },
        rpcOptions,
      );
    },
    ...createCodexThreadControlMethods(call, {
      ensureAlive: input.ensureAlive,
      ...(input.onBeforeInterruptTurn !== undefined && {
        onBeforeInterruptTurn: input.onBeforeInterruptTurn,
      }),
    }),
  };
}
