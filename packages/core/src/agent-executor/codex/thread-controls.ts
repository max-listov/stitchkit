import { abortReason } from '../../internal/abort-race';
import { assertTimerMs } from '../../internal/deadline';
import { assertNonNegativeSafeInteger } from '../../internal/positive-integer';
import type { JsonRpcValue } from '../json-rpc-peer';
import { safeJsonValue } from '../session-primitives';
import {
  type CodexThread,
  CodexThreadRevertResponseSchema,
  type CodexThreadSourceKind,
  parseCodexResponse,
} from './protocol';
import {
  CodexEmptyResponseSchema,
  type CodexLoadedThreadsPage,
  CodexLoadedThreadsPageSchema,
  type CodexThreadMetadataUpdateResponse,
  CodexThreadMetadataUpdateResponseSchema,
  type CodexThreadsPage,
  CodexThreadsPageSchema,
  type CodexThreadUnarchiveResponse,
  CodexThreadUnarchiveResponseSchema,
  type CodexThreadUnsubscribeResponse,
  CodexThreadUnsubscribeResponseSchema,
} from './responses';
import { buildListThreadsPayload, validateGitInfoUpdate } from './thread-list-query';

const MAX_UINT32 = 0xffff_ffff;

/** Per-call timeout and cancellation options accepted by {@link CodexControlClient} and {@link CodexSession} RPC methods. */
export interface CodexRpcCallOptions {
  /** Override the JSON-RPC request timeout in milliseconds for this call only. */
  readonly timeoutMs?: number | undefined;
  /** Cancel only this RPC call when aborted, leaving the underlying connection open. */
  readonly signal?: AbortSignal | undefined;
}

/** Eagerly validate per-call RPC timeout and abort state before doing async pre-work or side effects. */
export function validateCodexRpcCallOptions(options: CodexRpcCallOptions | undefined): void {
  if (options === undefined) return;
  if (options.timeoutMs !== undefined) {
    assertTimerMs('timeoutMs', options.timeoutMs);
  }
  if (options.signal?.aborted) {
    throw abortReason(options.signal);
  }
}

/** Thread identifier target shared by single-thread Codex RPCs (`thread/unsubscribe`, `thread/archive`, `thread/unarchive`, `thread/compact/start`). */
export interface CodexThreadIdParams {
  /** Thread identifier to target. */
  readonly threadId: string;
}

/** Parameters for Codex `turn/interrupt`. */
export interface CodexInterruptTurnParams {
  /** Thread identifier whose active turn will be interrupted. */
  readonly threadId: string;
  /** Turn identifier to interrupt (including external/TUI or reconnected turns). */
  readonly turnId: string;
}

/** Parameters for Codex `thread/revert`. */
export interface CodexRevertThreadParams {
  /** Thread identifier whose durable history will be reverted. */
  readonly threadId: string;
  /** Turn excluded from the replacement history, together with every later turn. */
  readonly beforeTurnId: string;
}

/** Result returned by Codex `thread/revert`. */
export interface CodexRevertThreadResult {
  /** Updated loaded thread metadata (`turns` is empty; hydrate via `thread/turns/list`). */
  readonly thread: CodexThread;
  /** Opaque cursor for hydrating retained turns backwards, or `null` when absent. */
  readonly turnsBackwardsCursor: string | null;
  /** Opaque cursor for hydrating retained items backwards, or `null` when absent. */
  readonly itemsBackwardsCursor: string | null;
}

/** Parameters for Codex `thread/inject_items`. */
export interface CodexInjectItemsParams {
  /** Thread identifier to append Responses API items into. */
  readonly threadId: string;
  /** Raw Responses API items to append to the thread's model-visible history. */
  readonly items: readonly JsonRpcValue[];
}

/** Sort key accepted by Codex `thread/list`. */
export type CodexThreadSortKey =
  | 'created_at'
  | 'updated_at'
  | 'recency_at'
  | 'section_position';

/** Parameters for Codex `thread/list`. */
export interface CodexListThreadsParams {
  /** Opaque pagination cursor returned by a previous call. */
  readonly cursor?: string | null | undefined;
  /** Optional page size (`uint32`). */
  readonly limit?: number | null | undefined;
  /** Optional sort key (`created_at`, `updated_at`, `recency_at`, or `section_position`). */
  readonly sortKey?: CodexThreadSortKey | null | undefined;
  /** Optional sort direction (`asc` or `desc`). */
  readonly sortDirection?: 'asc' | 'desc' | null | undefined;
  /** Optional provider allowlist filter. */
  readonly modelProviders?: readonly string[] | null | undefined;
  /** Optional source kind filter. */
  readonly sourceKinds?: readonly CodexThreadSourceKind[] | null | undefined;
  /** Optional archived filter (`true` for archived only; `false`/`null` for non-archived). */
  readonly archived?: boolean | null | undefined;
  /** Optional exact working directory filter (one path or list of paths). */
  readonly cwd?: string | readonly string[] | null | undefined;
  /** Optional substring filter for the extracted thread title. */
  readonly searchTerm?: string | null | undefined;
  /** Section filter: omit for all sections, `null` for unsectioned, or a section id string. */
  readonly sectionId?: string | null | undefined;
  /** Restrict results to up to 100 thread IDs before pagination. */
  readonly includedThreadIds?: readonly string[] | null | undefined;
  /** Exclude up to 100 thread IDs before applying the page limit. */
  readonly excludedThreadIds?: readonly string[] | null | undefined;
  /** Optional originator allowlist (hosted backends only). */
  readonly originators?: readonly string[] | null | undefined;
  /** Show local history visible to the current ChatGPT account. */
  readonly currentAccountOnly?: boolean | undefined;
  /** Return indexed local state-DB metadata without scanning JSONL rollouts. */
  readonly useStateDbOnly?: boolean | undefined;
}

/** Parameters for Codex `thread/loaded/list`. */
export interface CodexListLoadedThreadsParams {
  /** Opaque pagination cursor returned by a previous call. */
  readonly cursor?: string | null | undefined;
  /** Optional page size (`uint32`). */
  readonly limit?: number | null | undefined;
}

/** Git metadata patch accepted by Codex `thread/metadata/update`. */
export interface CodexThreadGitInfoUpdate {
  /** Omit to leave unchanged, `null` to clear, or a non-empty string to replace. */
  readonly branch?: string | null | undefined;
  /** Omit to leave unchanged, `null` to clear, or a non-empty string to replace. */
  readonly originUrl?: string | null | undefined;
  /** Omit to leave unchanged, `null` to clear, or a non-empty string to replace. */
  readonly sha?: string | null | undefined;
}

/** Parameters for Codex `thread/metadata/update`. */
export interface CodexUpdateThreadMetadataParams {
  /** Thread identifier whose stored metadata will be patched. */
  readonly threadId: string;
  /** Patch stored Git metadata for the thread. */
  readonly gitInfo?: CodexThreadGitInfoUpdate | null | undefined;
}

/** Parameters for Codex `thread/name/set`. */
export interface CodexSetThreadNameParams {
  /** Thread identifier to rename. */
  readonly threadId: string;
  /** Non-empty display name to assign to the thread. */
  readonly name: string;
}

/** Thread lifecycle, history, and catalog RPCs verified in `codex-cli 0.171.0`. */
export interface CodexThreadControlMethods {
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
  /** Interrupt a running turn on a thread (`turn/interrupt`), including external/TUI or reconnected turns. */
  interruptTurn(
    params: CodexInterruptTurnParams,
    options?: CodexRpcCallOptions,
  ): Promise<void>;
  /** Request context compaction for a thread (`thread/compact/start`). */
  compactThread(params: CodexThreadIdParams, options?: CodexRpcCallOptions): Promise<void>;
}

/** Validate a required non-empty thread identifier. */
export function assertNonEmptyThreadId(threadId: unknown, caller: string): string {
  if (typeof threadId !== 'string' || threadId.trim().length === 0) {
    throw new TypeError(`[stitchkit] ${caller}: threadId must be a non-empty string`);
  }
  return threadId;
}

/** Validate a required non-empty string parameter. */
export function assertRequiredNonEmptyString(
  value: unknown,
  field: string,
  caller: string,
): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`[stitchkit] ${caller}: ${field} must be a non-empty string`);
  }
  return value;
}

/** Validate an optional non-empty string parameter. */
export function assertOptionalNonEmptyString(
  value: string | undefined,
  field: string,
  caller: string,
): void {
  if (value === undefined) return;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`[stitchkit] ${caller}: ${field} must be a non-empty string`);
  }
}

/** Validate an optional non-empty string parameter without NUL bytes. */
export function assertOptionalNonEmptyNoNulString(
  value: string | undefined,
  field: string,
  caller: string,
): void {
  if (value === undefined) return;
  if (typeof value !== 'string' || value.trim().length === 0 || value.includes('\0')) {
    throw new TypeError(
      `[stitchkit] ${caller}: ${field} must be a non-empty string without NUL bytes`,
    );
  }
}

/** Validate an optional or nullable `uint32` page limit. */
export function assertOptionalLimit(limit: number | null | undefined, caller: string): void {
  if (limit === undefined || limit === null) return;
  assertNonNegativeSafeInteger(`[stitchkit] ${caller}: limit`, limit, TypeError);
  if (limit > MAX_UINT32) {
    throw new TypeError(`[stitchkit] ${caller}: limit must not exceed ${MAX_UINT32}`);
  }
}

/** Build the verified `0.171.0` thread lifecycle, revert, injection, interrupt, compaction, and catalog RPC methods. */
export function createCodexThreadControlMethods(
  call: (
    method: string,
    params?: Record<string, JsonRpcValue>,
    options?: CodexRpcCallOptions,
  ) => Promise<JsonRpcValue>,
  options: {
    readonly ensureAlive?: () => void;
    readonly onBeforeInterruptTurn?: (threadId: string, turnId: string) => void;
  } = {},
): CodexThreadControlMethods {
  return {
    async revertThread(params, rpcOptions) {
      const threadId = assertNonEmptyThreadId(
        params.threadId,
        'CodexControlClient.revertThread',
      );
      const beforeTurnId = assertRequiredNonEmptyString(
        params.beforeTurnId,
        'beforeTurnId',
        'CodexControlClient.revertThread',
      );
      const rawReply = await call('thread/revert', { threadId, beforeTurnId }, rpcOptions);
      const parsed = parseCodexResponse(
        'thread/revert',
        CodexThreadRevertResponseSchema,
        rawReply,
      );
      return {
        thread: parsed.thread,
        turnsBackwardsCursor: parsed.turnsBackwardsCursor ?? null,
        itemsBackwardsCursor: parsed.itemsBackwardsCursor ?? null,
      };
    },
    async injectItems(params, rpcOptions) {
      const threadId = assertNonEmptyThreadId(
        params.threadId,
        'CodexControlClient.injectItems',
      );
      if (!Array.isArray(params.items)) {
        throw new TypeError(
          '[stitchkit] CodexControlClient.injectItems: items must be an array',
        );
      }
      const items = params.items.map((item) => safeJsonValue(item));
      const raw = await call('thread/inject_items', { threadId, items }, rpcOptions);
      parseCodexResponse('thread/inject_items', CodexEmptyResponseSchema, raw);
    },
    async unsubscribeThread(params, rpcOptions) {
      const threadId = assertNonEmptyThreadId(
        params.threadId,
        'CodexControlClient.unsubscribeThread',
      );
      return parseCodexResponse(
        'thread/unsubscribe',
        CodexThreadUnsubscribeResponseSchema,
        await call('thread/unsubscribe', { threadId }, rpcOptions),
      );
    },
    async listThreads(params, rpcOptions) {
      return parseCodexResponse(
        'thread/list',
        CodexThreadsPageSchema,
        await call('thread/list', buildListThreadsPayload(params), rpcOptions),
      );
    },
    async listLoadedThreads(params, rpcOptions) {
      assertOptionalLimit(params?.limit, 'CodexControlClient.listLoadedThreads');
      return parseCodexResponse(
        'thread/loaded/list',
        CodexLoadedThreadsPageSchema,
        await call(
          'thread/loaded/list',
          {
            ...(params?.cursor !== undefined && { cursor: params.cursor }),
            ...(params?.limit !== undefined && { limit: params.limit }),
          },
          rpcOptions,
        ),
      );
    },
    async archiveThread(params, rpcOptions) {
      const threadId = assertNonEmptyThreadId(
        params.threadId,
        'CodexControlClient.archiveThread',
      );
      const raw = await call('thread/archive', { threadId }, rpcOptions);
      parseCodexResponse('thread/archive', CodexEmptyResponseSchema, raw);
    },
    async unarchiveThread(params, rpcOptions) {
      const threadId = assertNonEmptyThreadId(
        params.threadId,
        'CodexControlClient.unarchiveThread',
      );
      return parseCodexResponse(
        'thread/unarchive',
        CodexThreadUnarchiveResponseSchema,
        await call('thread/unarchive', { threadId }, rpcOptions),
      );
    },
    async updateThreadMetadata(params, rpcOptions) {
      const caller = 'CodexControlClient.updateThreadMetadata';
      const threadId = assertNonEmptyThreadId(params.threadId, caller);
      const gitInfo = validateGitInfoUpdate(params.gitInfo, caller);
      return parseCodexResponse(
        'thread/metadata/update',
        CodexThreadMetadataUpdateResponseSchema,
        await call(
          'thread/metadata/update',
          {
            threadId,
            ...(gitInfo !== undefined && { gitInfo }),
          },
          rpcOptions,
        ),
      );
    },
    async setThreadName(params, rpcOptions) {
      const caller = 'CodexControlClient.setThreadName';
      const threadId = assertNonEmptyThreadId(params.threadId, caller);
      const name = assertRequiredNonEmptyString(params.name, 'name', caller);
      const raw = await call('thread/name/set', { threadId, name }, rpcOptions);
      parseCodexResponse('thread/name/set', CodexEmptyResponseSchema, raw);
    },
    async interruptTurn(params, rpcOptions) {
      options.ensureAlive?.();
      validateCodexRpcCallOptions(rpcOptions);
      const caller = 'CodexControlClient.interruptTurn';
      const threadId = assertNonEmptyThreadId(params.threadId, caller);
      const turnId = assertRequiredNonEmptyString(params.turnId, 'turnId', caller);
      options.onBeforeInterruptTurn?.(threadId, turnId);
      await call('turn/interrupt', { threadId, turnId }, rpcOptions);
    },
    async compactThread(params, rpcOptions) {
      const threadId = assertNonEmptyThreadId(
        params.threadId,
        'CodexControlClient.compactThread',
      );
      await call('thread/compact/start', { threadId }, rpcOptions);
    },
  };
}
