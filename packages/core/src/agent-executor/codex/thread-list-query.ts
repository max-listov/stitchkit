import type { JsonRpcValue } from '../json-rpc-peer';
import {
  assertOptionalLimit,
  type CodexListThreadsParams,
  type CodexThreadGitInfoUpdate,
} from './thread-controls';

const MAX_THREAD_LIST_IDS = 100;

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

export function validateGitInfoUpdate(
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

export function buildListThreadsPayload(
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
