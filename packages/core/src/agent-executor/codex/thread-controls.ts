import { assertNonNegativeSafeInteger } from '../../internal/positive-integer';
import type { JsonRpcValue } from '../json-rpc-peer';
import { safeJsonValue } from '../session-primitives';
import { CodexThreadRevertResponseSchema } from './protocol';

const MAX_UINT32 = 0xffff_ffff;
const MAX_THREAD_LIST_IDS = 100;

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
  readonly thread: JsonRpcValue;
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

/** Thread source kind filter accepted by Codex `thread/list`. */
export type CodexThreadSourceKind =
  | 'cli'
  | 'vscode'
  | 'exec'
  | 'appServer'
  | 'subAgent'
  | 'subAgentReview'
  | 'subAgentCompact'
  | 'subAgentThreadSpawn'
  | 'subAgentOther'
  | 'unknown';

/** Parameters for Codex `thread/list`. */
export interface CodexListThreadsParams {
  /** Opaque pagination cursor returned by a previous call. */
  readonly cursor?: string | null;
  /** Optional page size (`uint32`). */
  readonly limit?: number | null;
  /** Optional sort key (`created_at`, `updated_at`, `recency_at`, or `section_position`). */
  readonly sortKey?: CodexThreadSortKey | null;
  /** Optional sort direction (`asc` or `desc`). */
  readonly sortDirection?: 'asc' | 'desc' | null;
  /** Optional provider allowlist filter. */
  readonly modelProviders?: readonly string[] | null;
  /** Optional source kind filter. */
  readonly sourceKinds?: readonly CodexThreadSourceKind[] | null;
  /** Optional archived filter (`true` for archived only; `false`/`null` for non-archived). */
  readonly archived?: boolean | null;
  /** Optional exact working directory filter (one path or list of paths). */
  readonly cwd?: string | readonly string[] | null;
  /** Optional substring filter for the extracted thread title. */
  readonly searchTerm?: string | null;
  /** Section filter: omit for all sections, `null` for unsectioned, or a section id string. */
  readonly sectionId?: string | null;
  /** Restrict results to up to 100 thread IDs before pagination. */
  readonly includedThreadIds?: readonly string[] | null;
  /** Exclude up to 100 thread IDs before applying the page limit. */
  readonly excludedThreadIds?: readonly string[] | null;
  /** Optional originator allowlist (hosted backends only). */
  readonly originators?: readonly string[] | null;
  /** Show local history visible to the current ChatGPT account. */
  readonly currentAccountOnly?: boolean;
  /** Return indexed local state-DB metadata without scanning JSONL rollouts. */
  readonly useStateDbOnly?: boolean;
}

/** Parameters for Codex `thread/loaded/list`. */
export interface CodexListLoadedThreadsParams {
  /** Opaque pagination cursor returned by a previous call. */
  readonly cursor?: string | null;
  /** Optional page size (`uint32`). */
  readonly limit?: number | null;
}

/** Git metadata patch accepted by Codex `thread/metadata/update`. */
export interface CodexThreadGitInfoUpdate {
  /** Omit to leave unchanged, `null` to clear, or a non-empty string to replace. */
  readonly branch?: string | null;
  /** Omit to leave unchanged, `null` to clear, or a non-empty string to replace. */
  readonly originUrl?: string | null;
  /** Omit to leave unchanged, `null` to clear, or a non-empty string to replace. */
  readonly sha?: string | null;
}

/** Parameters for Codex `thread/metadata/update`. */
export interface CodexUpdateThreadMetadataParams {
  /** Thread identifier whose stored metadata will be patched. */
  readonly threadId: string;
  /** Patch stored Git metadata for the thread. */
  readonly gitInfo?: CodexThreadGitInfoUpdate | null;
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
  /** Interrupt a running turn on a thread (`turn/interrupt`), including external/TUI or reconnected turns. */
  interruptTurn(params: CodexInterruptTurnParams): Promise<void>;
  /** Request context compaction for a thread (`thread/compact/start`). */
  compactThread(params: CodexThreadIdParams): Promise<void>;
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

function assertBoundedThreadIdFilter(
  ids: readonly string[] | null | undefined,
  field: 'includedThreadIds' | 'excludedThreadIds',
  caller: string,
): readonly string[] | null | undefined {
  if (ids === undefined || ids === null) return ids;
  if (!Array.isArray(ids)) {
    throw new TypeError(`[stitchkit] ${caller}: ${field} must be an array of strings`);
  }
  if (ids.length > MAX_THREAD_LIST_IDS) {
    throw new TypeError(
      `[stitchkit] ${caller}: ${field} must contain at most ${MAX_THREAD_LIST_IDS} entries`,
    );
  }
  for (const id of ids) {
    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new TypeError(
        `[stitchkit] ${caller}: every ${field} entry must be a non-empty string`,
      );
    }
  }
  return [...ids];
}

function validateGitInfoUpdate(
  gitInfo: CodexThreadGitInfoUpdate | null | undefined,
  caller: string,
): JsonRpcValue | undefined {
  if (gitInfo === undefined) return undefined;
  if (gitInfo === null) return null;
  if (typeof gitInfo !== 'object' || Array.isArray(gitInfo)) {
    throw new TypeError(`[stitchkit] ${caller}: gitInfo must be a plain object or null`);
  }
  const normalized: Record<string, JsonRpcValue> = {};
  for (const field of ['branch', 'originUrl', 'sha'] as const) {
    const value = gitInfo[field];
    if (value === undefined) continue;
    if (value === null) {
      normalized[field] = null;
      continue;
    }
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new TypeError(
        `[stitchkit] ${caller}: gitInfo.${field} must be a non-empty string or null`,
      );
    }
    normalized[field] = value;
  }
  return normalized;
}

function normalizeListThreadsCwd(
  cwd: string | readonly string[] | null | undefined,
): string | string[] | null | undefined {
  if (cwd === undefined || cwd === null || typeof cwd === 'string') return cwd;
  return [...cwd];
}

function buildListThreadsPayload(
  params: CodexListThreadsParams | undefined,
): Record<string, JsonRpcValue> {
  const caller = 'CodexControlClient.listThreads';
  assertOptionalLimit(params?.limit, caller);
  const includedThreadIds = assertBoundedThreadIdFilter(
    params?.includedThreadIds,
    'includedThreadIds',
    caller,
  );
  const excludedThreadIds = assertBoundedThreadIdFilter(
    params?.excludedThreadIds,
    'excludedThreadIds',
    caller,
  );
  const cwd = normalizeListThreadsCwd(params?.cwd);
  return {
    ...(params?.cursor !== undefined && { cursor: params.cursor }),
    ...(params?.limit !== undefined && { limit: params.limit }),
    ...(params?.sortKey !== undefined && { sortKey: params.sortKey }),
    ...(params?.sortDirection !== undefined && { sortDirection: params.sortDirection }),
    ...(params?.modelProviders !== undefined && {
      modelProviders: params.modelProviders === null ? null : [...params.modelProviders],
    }),
    ...(params?.sourceKinds !== undefined && {
      sourceKinds: params.sourceKinds === null ? null : [...params.sourceKinds],
    }),
    ...(params?.archived !== undefined && { archived: params.archived }),
    ...(cwd !== undefined && { cwd }),
    ...(params?.searchTerm !== undefined && { searchTerm: params.searchTerm }),
    ...(params?.sectionId !== undefined && { sectionId: params.sectionId }),
    ...(includedThreadIds !== undefined && {
      includedThreadIds: includedThreadIds === null ? null : [...includedThreadIds],
    }),
    ...(excludedThreadIds !== undefined && {
      excludedThreadIds: excludedThreadIds === null ? null : [...excludedThreadIds],
    }),
    ...(params?.originators !== undefined && {
      originators: params.originators === null ? null : [...params.originators],
    }),
    ...(params?.currentAccountOnly !== undefined && {
      currentAccountOnly: params.currentAccountOnly,
    }),
    ...(params?.useStateDbOnly !== undefined && { useStateDbOnly: params.useStateDbOnly }),
  };
}

/** Build the verified `0.171.0` thread lifecycle, revert, injection, interrupt, compaction, and catalog RPC methods. */
export function createCodexThreadControlMethods(
  call: (method: string, params?: Record<string, JsonRpcValue>) => Promise<JsonRpcValue>,
  options: {
    readonly ensureAlive?: () => void;
    readonly onBeforeInterruptTurn?: (threadId: string, turnId: string) => void;
  } = {},
): CodexThreadControlMethods {
  return {
    async revertThread(params) {
      const threadId = assertNonEmptyThreadId(
        params.threadId,
        'CodexControlClient.revertThread',
      );
      const beforeTurnId = assertRequiredNonEmptyString(
        params.beforeTurnId,
        'beforeTurnId',
        'CodexControlClient.revertThread',
      );
      const rawReply = await call('thread/revert', { threadId, beforeTurnId });
      const parsed = CodexThreadRevertResponseSchema.parse(rawReply);
      return {
        thread: safeJsonValue(parsed.thread),
        turnsBackwardsCursor: parsed.turnsBackwardsCursor ?? null,
        itemsBackwardsCursor: parsed.itemsBackwardsCursor ?? null,
      };
    },
    async injectItems(params) {
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
      return call('thread/inject_items', { threadId, items });
    },
    async unsubscribeThread(params) {
      const threadId = assertNonEmptyThreadId(
        params.threadId,
        'CodexControlClient.unsubscribeThread',
      );
      return call('thread/unsubscribe', { threadId });
    },
    async listThreads(params) {
      return call('thread/list', buildListThreadsPayload(params));
    },
    async listLoadedThreads(params) {
      assertOptionalLimit(params?.limit, 'CodexControlClient.listLoadedThreads');
      return call('thread/loaded/list', {
        ...(params?.cursor !== undefined && { cursor: params.cursor }),
        ...(params?.limit !== undefined && { limit: params.limit }),
      });
    },
    async archiveThread(params) {
      const threadId = assertNonEmptyThreadId(
        params.threadId,
        'CodexControlClient.archiveThread',
      );
      return call('thread/archive', { threadId });
    },
    async unarchiveThread(params) {
      const threadId = assertNonEmptyThreadId(
        params.threadId,
        'CodexControlClient.unarchiveThread',
      );
      return call('thread/unarchive', { threadId });
    },
    async updateThreadMetadata(params) {
      const caller = 'CodexControlClient.updateThreadMetadata';
      const threadId = assertNonEmptyThreadId(params.threadId, caller);
      const gitInfo = validateGitInfoUpdate(params.gitInfo, caller);
      return call('thread/metadata/update', {
        threadId,
        ...(gitInfo !== undefined && { gitInfo }),
      });
    },
    async setThreadName(params) {
      const caller = 'CodexControlClient.setThreadName';
      const threadId = assertNonEmptyThreadId(params.threadId, caller);
      const name = assertRequiredNonEmptyString(params.name, 'name', caller);
      return call('thread/name/set', { threadId, name });
    },
    async interruptTurn(params) {
      options.ensureAlive?.();
      const caller = 'CodexControlClient.interruptTurn';
      const threadId = assertNonEmptyThreadId(params.threadId, caller);
      const turnId = assertRequiredNonEmptyString(params.turnId, 'turnId', caller);
      options.onBeforeInterruptTurn?.(threadId, turnId);
      await call('turn/interrupt', { threadId, turnId });
    },
    async compactThread(params) {
      const threadId = assertNonEmptyThreadId(
        params.threadId,
        'CodexControlClient.compactThread',
      );
      await call('thread/compact/start', { threadId });
    },
  };
}
