import type {
  CodexControlClient,
  CodexListItemsParams,
  CodexListTurnsParams,
  CodexReadThreadParams,
} from './control-client';
import type {
  CodexInjectItemsParams,
  CodexInterruptTurnParams,
  CodexRevertThreadParams,
  CodexRpcCallOptions,
  CodexSetThreadNameParams,
  CodexUpdateThreadMetadataParams,
} from './thread-controls';
import type { CodexResumeThreadParams } from './thread-open';

/**
 * Bind all thread-scoped {@link CodexControlClient} methods to default `threadId` to a session's
 * `nativeThreadId`. `startThreadTurn` stays unbound so callers always supply `threadId` explicitly
 * rather than confusing it with slot-managed {@link CodexSession.startTurn}.
 */
export function bindCodexSessionThreadControls(
  controlClient: CodexControlClient,
  threadId: string,
) {
  return {
    readThread(
      params?: Omit<CodexReadThreadParams, 'threadId'> & {
        readonly threadId?: string | undefined;
      },
      options?: CodexRpcCallOptions,
    ) {
      return controlClient.readThread(
        {
          ...params,
          threadId: params?.threadId ?? threadId,
        },
        options,
      );
    },
    listTurns(
      params?: Omit<CodexListTurnsParams, 'threadId'> & {
        readonly threadId?: string | undefined;
      },
      options?: CodexRpcCallOptions,
    ) {
      return controlClient.listTurns(
        {
          ...params,
          threadId: params?.threadId ?? threadId,
        },
        options,
      );
    },
    listItems(
      params?: Omit<CodexListItemsParams, 'threadId'> & {
        readonly threadId?: string | undefined;
      },
      options?: CodexRpcCallOptions,
    ) {
      return controlClient.listItems(
        {
          ...params,
          threadId: params?.threadId ?? threadId,
        },
        options,
      );
    },
    resumeThread(
      params?: Omit<CodexResumeThreadParams, 'threadId'> & {
        readonly threadId?: string | undefined;
      },
      options?: CodexRpcCallOptions,
    ) {
      return controlClient.resumeThread(
        {
          ...params,
          threadId: params?.threadId ?? threadId,
        },
        options,
      );
    },
    revertThread(
      params: Omit<CodexRevertThreadParams, 'threadId'> & {
        readonly threadId?: string | undefined;
      },
      options?: CodexRpcCallOptions,
    ) {
      return controlClient.revertThread(
        {
          ...params,
          threadId: params.threadId ?? threadId,
        },
        options,
      );
    },
    injectItems(
      params: Omit<CodexInjectItemsParams, 'threadId'> & {
        readonly threadId?: string | undefined;
      },
      options?: CodexRpcCallOptions,
    ) {
      return controlClient.injectItems(
        {
          ...params,
          threadId: params.threadId ?? threadId,
        },
        options,
      );
    },
    unsubscribeThread(
      params?: { readonly threadId?: string | undefined },
      options?: CodexRpcCallOptions,
    ) {
      return controlClient.unsubscribeThread(
        {
          threadId: params?.threadId ?? threadId,
        },
        options,
      );
    },
    archiveThread(
      params?: { readonly threadId?: string | undefined },
      options?: CodexRpcCallOptions,
    ) {
      return controlClient.archiveThread(
        {
          threadId: params?.threadId ?? threadId,
        },
        options,
      );
    },
    unarchiveThread(
      params?: { readonly threadId?: string | undefined },
      options?: CodexRpcCallOptions,
    ) {
      return controlClient.unarchiveThread(
        {
          threadId: params?.threadId ?? threadId,
        },
        options,
      );
    },
    updateThreadMetadata(
      params?: Omit<CodexUpdateThreadMetadataParams, 'threadId'> & {
        readonly threadId?: string | undefined;
      },
      options?: CodexRpcCallOptions,
    ) {
      return controlClient.updateThreadMetadata(
        {
          ...params,
          threadId: params?.threadId ?? threadId,
        },
        options,
      );
    },
    setThreadName(
      params: Omit<CodexSetThreadNameParams, 'threadId'> & {
        readonly threadId?: string | undefined;
      },
      options?: CodexRpcCallOptions,
    ) {
      return controlClient.setThreadName(
        {
          ...params,
          threadId: params.threadId ?? threadId,
        },
        options,
      );
    },
    interruptTurn(
      params: Omit<CodexInterruptTurnParams, 'threadId'> & {
        readonly threadId?: string | undefined;
      },
      options?: CodexRpcCallOptions,
    ) {
      return controlClient.interruptTurn(
        {
          ...params,
          threadId: params.threadId ?? threadId,
        },
        options,
      );
    },
    compactThread(
      params?: { readonly threadId?: string | undefined },
      options?: CodexRpcCallOptions,
    ) {
      return controlClient.compactThread(
        {
          threadId: params?.threadId ?? threadId,
        },
        options,
      );
    },
  };
}
