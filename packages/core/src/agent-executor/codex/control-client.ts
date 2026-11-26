import type { InteractionReply } from '../executor-contract';
import type { JsonRpcPeer, JsonRpcValue } from '../json-rpc-peer';
import type { ExecutorProfileConfig } from '../profile';
import { safeJsonValue } from '../session-primitives';
import type { ExecutorStartupPhase } from '../vocabulary';
import {
  assertNonEmptyThreadId,
  assertOptionalLimit,
  assertOptionalNonEmptyString,
  type CodexInjectItemsParams,
  type CodexListLoadedThreadsParams,
  type CodexListThreadsParams,
  type CodexRevertThreadParams,
  type CodexRevertThreadResult,
  type CodexSetThreadNameParams,
  type CodexThreadIdParams,
  type CodexUpdateThreadMetadataParams,
  createCodexThreadControlMethods,
} from './thread-controls';

/** Parameters for Codex `thread/read`. */
export interface CodexReadThreadParams {
  /** Thread identifier to inspect. */
  readonly threadId: string;
  /** When `true`, include full rollout turns (deprecated for large threads). */
  readonly includeTurns?: boolean;
}

/** Parameters for Codex `thread/turns/list`. */
export interface CodexListTurnsParams {
  /** Thread identifier whose turns to list. */
  readonly threadId: string;
  /** Opaque continuation cursor returned by a previous page. */
  readonly cursor?: string;
  /** Optional page size (`uint32`). */
  readonly limit?: number;
  /** Level of item detail per turn (`notLoaded`, `summary`, or `full`). */
  readonly itemsView?: 'notLoaded' | 'summary' | 'full';
  /** Pagination direction (`asc` or `desc`). */
  readonly sortDirection?: 'asc' | 'desc';
}

/** Starting position for a `thread/items/list` page: opaque string cursor or exclusive item anchor. */
export type CodexThreadItemsCursor =
  | string
  | { readonly type: 'item'; readonly itemId: string };

/** Output deferral preferences accepted by Codex `thread/items/list`. */
export interface CodexThreadItemsDeferOutput {
  /** Defer nonempty output from successful commands. */
  readonly commandExecution?: boolean;
  /** Defer nonempty plain-text results from successful MCP tool calls. */
  readonly mcpToolCall?: boolean;
}

/** Parameters for Codex `thread/items/list`. */
export interface CodexListItemsParams {
  /** Thread identifier whose items to list. */
  readonly threadId: string;
  /** Optional turn identifier to filter items to one turn. */
  readonly turnId?: string;
  /** Opaque continuation cursor or exclusive item anchor within `turnId`. */
  readonly cursor?: CodexThreadItemsCursor;
  /** Optional page size (`uint32`). */
  readonly limit?: number;
  /** Pagination direction (`asc` or `desc`). */
  readonly sortDirection?: 'asc' | 'desc';
  /** Output deferral flags for single-turn item reads. */
  readonly deferOutput?: CodexThreadItemsDeferOutput;
}

/** Read-only and inspection RPCs exposed during thread setup (`prepareThread` / `verifyThread`), on {@link CodexControlConnection}, and on {@link CodexSession}. */
export interface CodexControlClient {
  /** Read effective Codex configuration (`config/read`). */
  readConfig(params?: {
    readonly cwd?: string;
    readonly includeLayers?: boolean;
  }): Promise<JsonRpcValue>;
  /** Read thread metadata and live status (`thread/read`). */
  readThread(params: CodexReadThreadParams): Promise<JsonRpcValue>;
  /** List collaboration mode presets (`collaborationMode/list`). */
  listCollaborationModes(): Promise<JsonRpcValue>;
  /** List turns in a thread (`thread/turns/list`). */
  listTurns(params: CodexListTurnsParams): Promise<JsonRpcValue>;
  /** List items in a thread or single turn (`thread/items/list`). */
  listItems(params: CodexListItemsParams): Promise<JsonRpcValue>;
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
  /** Revert a thread's durable history to before `beforeTurnId` (`thread/revert`). */
  revertThread(params: CodexRevertThreadParams): Promise<CodexRevertThreadResult>;
  /** Append raw Responses API items to a thread's model-visible history (`thread/inject_items`). */
  injectItems(params: CodexInjectItemsParams): Promise<JsonRpcValue>;
  /** Unsubscribe this connection from a thread (`thread/unsubscribe`). */
  unsubscribeThread(params: CodexThreadIdParams): Promise<JsonRpcValue>;
  /** List threads with pagination and bounded filters (`thread/list`). */
  listThreads(params?: CodexListThreadsParams): Promise<JsonRpcValue>;
  /** List thread identifiers currently loaded in memory (`thread/loaded/list`). */
  listLoadedThreads(params?: CodexListLoadedThreadsParams): Promise<JsonRpcValue>;
  /** Archive a thread (`thread/archive`). */
  archiveThread(params: CodexThreadIdParams): Promise<JsonRpcValue>;
  /** Unarchive a thread (`thread/unarchive`). */
  unarchiveThread(params: CodexThreadIdParams): Promise<JsonRpcValue>;
  /** Patch stored metadata (such as Git info) for a thread (`thread/metadata/update`). */
  updateThreadMetadata(params: CodexUpdateThreadMetadataParams): Promise<JsonRpcValue>;
  /** Set a thread's display name (`thread/name/set`). */
  setThreadName(params: CodexSetThreadNameParams): Promise<JsonRpcValue>;
}

/** Input to {@link CodexDriver.connectControl} for a threadless app-server connection. */
export interface CodexControlConnectInput {
  readonly profile: ExecutorProfileConfig;
  readonly cwd: string;
  /** Optional observer invoked with startup phases (`spawning`, `initializing`) during connect. */
  readonly onStartupPhase?: (phase: ExecutorStartupPhase) => void;
  readonly signal?: AbortSignal;
}

/** Threadless connection to a Codex app-server for catalog/config reads and external observation. */
export interface CodexControlConnection extends CodexControlClient {
  /** OS process id of the spawned `codex app-server`, or `undefined` when attached via `unix-connect`. */
  readonly providerPid: number | undefined;
  /** Answer a pending external server request received via `onServerRequest`. */
  respond(interactionId: string, reply: InteractionReply['reply']): Promise<void>;
  /** Close the connection cleanly (does not kill an external server in `unix-connect` mode). */
  close(): Promise<void>;
}

function assertOptionalItemsCursor(
  cursor: CodexThreadItemsCursor | undefined,
  caller: string,
): void {
  if (cursor === undefined) return;
  if (typeof cursor === 'string') {
    if (cursor.trim().length === 0) {
      throw new TypeError(`[stitchkit] ${caller}: cursor must be a non-empty string`);
    }
    return;
  }
  if (
    typeof cursor !== 'object' ||
    cursor === null ||
    cursor.type !== 'item' ||
    typeof cursor.itemId !== 'string' ||
    cursor.itemId.trim().length === 0
  ) {
    throw new TypeError(
      `[stitchkit] ${caller}: item cursor must have type "item" and a non-empty itemId`,
    );
  }
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
    async readThread(params) {
      const threadId = assertNonEmptyThreadId(
        params.threadId,
        'CodexControlClient.readThread',
      );
      return call('thread/read', {
        threadId,
        ...(params.includeTurns !== undefined && { includeTurns: params.includeTurns }),
      });
    },
    listCollaborationModes() {
      return call('collaborationMode/list', {});
    },
    async listTurns(params) {
      const threadId = assertNonEmptyThreadId(params.threadId, 'CodexControlClient.listTurns');
      assertOptionalLimit(params.limit, 'CodexControlClient.listTurns');
      return call('thread/turns/list', {
        threadId,
        ...(params.cursor !== undefined && { cursor: params.cursor }),
        ...(params.limit !== undefined && { limit: params.limit }),
        ...(params.itemsView !== undefined && { itemsView: params.itemsView }),
        ...(params.sortDirection !== undefined && { sortDirection: params.sortDirection }),
      });
    },
    async listItems(params) {
      const threadId = assertNonEmptyThreadId(params.threadId, 'CodexControlClient.listItems');
      assertOptionalLimit(params.limit, 'CodexControlClient.listItems');
      assertOptionalNonEmptyString(params.turnId, 'turnId', 'CodexControlClient.listItems');
      assertOptionalItemsCursor(params.cursor, 'CodexControlClient.listItems');
      return call('thread/items/list', {
        threadId,
        ...(params.turnId !== undefined && { turnId: params.turnId }),
        ...(params.cursor !== undefined && { cursor: safeJsonValue(params.cursor) }),
        ...(params.limit !== undefined && { limit: params.limit }),
        ...(params.sortDirection !== undefined && { sortDirection: params.sortDirection }),
        ...(params.deferOutput !== undefined && {
          deferOutput: safeJsonValue(params.deferOutput),
        }),
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
    ...createCodexThreadControlMethods(call),
  };
}

/** Bind all thread-scoped {@link CodexControlClient} methods to default `threadId` to a session's `nativeThreadId`. */
export function bindCodexSessionThreadControls(
  controlClient: CodexControlClient,
  threadId: string,
) {
  return {
    readThread(
      params?: Omit<CodexReadThreadParams, 'threadId'> & { readonly threadId?: string },
    ) {
      return controlClient.readThread({
        ...params,
        threadId: params?.threadId ?? threadId,
      });
    },
    listTurns(
      params?: Omit<CodexListTurnsParams, 'threadId'> & { readonly threadId?: string },
    ) {
      return controlClient.listTurns({
        ...params,
        threadId: params?.threadId ?? threadId,
      });
    },
    listItems(
      params?: Omit<CodexListItemsParams, 'threadId'> & { readonly threadId?: string },
    ) {
      return controlClient.listItems({
        ...params,
        threadId: params?.threadId ?? threadId,
      });
    },
    revertThread(
      params: Omit<CodexRevertThreadParams, 'threadId'> & { readonly threadId?: string },
    ) {
      return controlClient.revertThread({
        ...params,
        threadId: params.threadId ?? threadId,
      });
    },
    injectItems(
      params: Omit<CodexInjectItemsParams, 'threadId'> & { readonly threadId?: string },
    ) {
      return controlClient.injectItems({
        ...params,
        threadId: params.threadId ?? threadId,
      });
    },
    unsubscribeThread(params?: { readonly threadId?: string }) {
      return controlClient.unsubscribeThread({
        threadId: params?.threadId ?? threadId,
      });
    },
    archiveThread(params?: { readonly threadId?: string }) {
      return controlClient.archiveThread({
        threadId: params?.threadId ?? threadId,
      });
    },
    unarchiveThread(params?: { readonly threadId?: string }) {
      return controlClient.unarchiveThread({
        threadId: params?.threadId ?? threadId,
      });
    },
    updateThreadMetadata(
      params?: Omit<CodexUpdateThreadMetadataParams, 'threadId'> & {
        readonly threadId?: string;
      },
    ) {
      return controlClient.updateThreadMetadata({
        ...params,
        threadId: params?.threadId ?? threadId,
      });
    },
    setThreadName(
      params: Omit<CodexSetThreadNameParams, 'threadId'> & { readonly threadId?: string },
    ) {
      return controlClient.setThreadName({
        ...params,
        threadId: params.threadId ?? threadId,
      });
    },
  };
}
