import type { JsonRpcValue } from '../json-rpc-peer';
import { safeJsonValue } from '../session-primitives';
import type { CodexControlClient, CodexThreadItemsCursor } from './control-client';
import { CodexTurnsPageSchema, parseCodexResponse } from './protocol';
import {
  CodexAccountReadResponseSchema,
  CodexCollaborationModesResponseSchema,
  CodexConfigReadResponseSchema,
  CodexItemsPageSchema,
  CodexMcpServerStatusPageSchema,
  CodexModelsPageSchema,
  CodexRateLimitsResponseSchema,
  CodexReadThreadResponseSchema,
  CodexSkillsListResponseSchema,
} from './responses';
import {
  assertNonEmptyThreadId,
  assertOptionalLimit,
  assertOptionalNonEmptyString,
  type CodexRpcCallOptions,
} from './thread-controls';

type CodexRpcCaller = (
  method: string,
  params?: Record<string, JsonRpcValue>,
  rpcOptions?: CodexRpcCallOptions,
) => Promise<JsonRpcValue>;

function assertOptionalItemsCursor(
  cursor: CodexThreadItemsCursor | null | undefined,
  caller: string,
): void {
  if (cursor === undefined || cursor === null || cursor === '') return;
  if (typeof cursor === 'string') {
    if (cursor.trim().length === 0) {
      throw new TypeError(`[stitchkit] ${caller}: item cursor cannot be whitespace-only`);
    }
    return;
  }
  if (
    typeof cursor !== 'object' ||
    cursor.type !== 'item' ||
    typeof cursor.itemId !== 'string' ||
    cursor.itemId.trim().length === 0
  ) {
    throw new TypeError(
      `[stitchkit] ${caller}: item cursor must have type "item" and a non-empty itemId`,
    );
  }
}

export function createCodexReadMethods(
  call: CodexRpcCaller,
): Pick<
  CodexControlClient,
  | 'readConfig'
  | 'readThread'
  | 'listCollaborationModes'
  | 'listTurns'
  | 'listItems'
  | 'listMcpServerStatus'
  | 'listSkills'
  | 'listModels'
  | 'readAccount'
  | 'readRateLimits'
> {
  return {
    async readConfig(params, rpcOptions) {
      return parseCodexResponse(
        'config/read',
        CodexConfigReadResponseSchema,
        await call(
          'config/read',
          {
            ...(params?.cwd !== undefined && { cwd: params.cwd }),
            ...(params?.includeLayers !== undefined && {
              includeLayers: params.includeLayers,
            }),
          },
          rpcOptions,
        ),
      );
    },
    async readThread(params, rpcOptions) {
      const threadId = assertNonEmptyThreadId(
        params.threadId,
        'CodexControlClient.readThread',
      );
      return parseCodexResponse(
        'thread/read',
        CodexReadThreadResponseSchema,
        await call(
          'thread/read',
          {
            threadId,
            ...(params.includeTurns !== undefined && { includeTurns: params.includeTurns }),
          },
          rpcOptions,
        ),
      );
    },
    async listCollaborationModes(rpcOptions) {
      return parseCodexResponse(
        'collaborationMode/list',
        CodexCollaborationModesResponseSchema,
        await call('collaborationMode/list', {}, rpcOptions),
      );
    },
    async listTurns(params, rpcOptions) {
      const caller = 'CodexControlClient.listTurns';
      const threadId = assertNonEmptyThreadId(params.threadId, caller);
      assertOptionalLimit(params.limit, caller);
      if (
        params.cursor !== undefined &&
        params.cursor !== null &&
        typeof params.cursor !== 'string'
      ) {
        throw new TypeError(`[stitchkit] ${caller}: cursor must be a string or null`);
      }
      return parseCodexResponse(
        'thread/turns/list',
        CodexTurnsPageSchema,
        await call(
          'thread/turns/list',
          {
            threadId,
            ...(params.cursor !== undefined && { cursor: params.cursor }),
            ...(params.limit !== undefined && { limit: params.limit }),
            ...(params.itemsView !== undefined && { itemsView: params.itemsView }),
            ...(params.sortDirection !== undefined && { sortDirection: params.sortDirection }),
          },
          rpcOptions,
        ),
      );
    },
    async listItems(params, rpcOptions) {
      const caller = 'CodexControlClient.listItems';
      const threadId = assertNonEmptyThreadId(params.threadId, caller);
      assertOptionalLimit(params.limit, caller);
      assertOptionalNonEmptyString(params.turnId, 'turnId', caller);
      assertOptionalItemsCursor(params.cursor, caller);
      return parseCodexResponse(
        'thread/items/list',
        CodexItemsPageSchema,
        await call(
          'thread/items/list',
          {
            threadId,
            ...(params.turnId !== undefined && { turnId: params.turnId }),
            ...(params.cursor !== undefined && { cursor: safeJsonValue(params.cursor) }),
            ...(params.limit !== undefined && { limit: params.limit }),
            ...(params.sortDirection !== undefined && { sortDirection: params.sortDirection }),
            ...(params.deferOutput !== undefined && {
              deferOutput: safeJsonValue(params.deferOutput),
            }),
          },
          rpcOptions,
        ),
      );
    },
    async listMcpServerStatus(params, rpcOptions) {
      return parseCodexResponse(
        'mcpServerStatus/list',
        CodexMcpServerStatusPageSchema,
        await call(
          'mcpServerStatus/list',
          {
            ...(params?.cursor !== undefined && { cursor: params.cursor }),
            ...(params?.limit !== undefined && { limit: params.limit }),
            ...(params?.threadId !== undefined && { threadId: params.threadId }),
            ...(params?.serverName !== undefined && { serverName: params.serverName }),
            ...(params?.detail !== undefined && { detail: params.detail }),
          },
          rpcOptions,
        ),
      );
    },
    async listSkills(params, rpcOptions) {
      return parseCodexResponse(
        'skills/list',
        CodexSkillsListResponseSchema,
        await call(
          'skills/list',
          {
            ...(params?.cwds !== undefined && { cwds: [...params.cwds] }),
            ...(params?.forceReload !== undefined && { forceReload: params.forceReload }),
          },
          rpcOptions,
        ),
      );
    },
    async listModels(params, rpcOptions) {
      return parseCodexResponse(
        'model/list',
        CodexModelsPageSchema,
        await call(
          'model/list',
          {
            ...(params?.cursor !== undefined && { cursor: params.cursor }),
            ...(params?.limit !== undefined && { limit: params.limit }),
            ...(params?.includeHidden !== undefined && {
              includeHidden: params.includeHidden,
            }),
            ...(params?.modelProvider !== undefined && {
              modelProvider: params.modelProvider,
            }),
          },
          rpcOptions,
        ),
      );
    },
    async readAccount(params, rpcOptions) {
      return parseCodexResponse(
        'account/read',
        CodexAccountReadResponseSchema,
        await call(
          'account/read',
          {
            ...(params?.refreshToken !== undefined && { refreshToken: params.refreshToken }),
          },
          rpcOptions,
        ),
      );
    },
    async readRateLimits(rpcOptions) {
      return parseCodexResponse(
        'account/rateLimits/read',
        CodexRateLimitsResponseSchema,
        await call('account/rateLimits/read', undefined, rpcOptions),
      );
    },
  };
}
