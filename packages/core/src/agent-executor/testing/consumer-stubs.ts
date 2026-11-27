import type { AcpSession } from '../acp/v1-session';
import type { ClaudeSdkSession } from '../claude-sdk/driver';
import type { CodexControlClient, CodexControlConnection } from '../codex/control-client';
import type { CodexSession, CodexTurn } from '../codex/session-types';
import type { CodexSharedServer } from '../codex/shared-server';
import type { AgentEngineTurn } from '../engine';
import type { ExecutorDriverCapabilities } from '../hello';
import type { ExecutorDelta } from '../vocabulary';
import { makeCodexThreadFixture } from './fixtures';

/**
 * Override map compatible with `exactOptionalPropertyTypes: true`: every property of `T` may be
 * omitted or explicitly set to `undefined`.
 */
export type StubOverrides<T> = {
  [K in keyof T]?: T[K] | undefined;
};

/** Overrides accepted by {@link createStubAgentEngineTurn}. */
export interface StubAgentEngineTurnOverrides {
  /** Deltas yielded by the turn (array or async iterable). Defaults to `[]`. */
  readonly deltas?: readonly ExecutorDelta[] | AsyncIterable<ExecutorDelta> | undefined;
  /** Override `interrupt()`. Defaults to throwing an unexpected-call error. */
  readonly interrupt?: AgentEngineTurn['interrupt'] | undefined;
  /** Override `respond()`. Defaults to throwing an unexpected-call error. */
  readonly respond?: AgentEngineTurn['respond'] | undefined;
}

/** Overrides accepted by {@link createStubCodexTurn}. */
export interface StubCodexTurnOverrides extends StubAgentEngineTurnOverrides {
  /** Native turn identifier assigned by Codex. Defaults to `'stub-turn-1'`. */
  readonly nativeTurnId?: string | undefined;
}

const DEFAULT_CODEX_USER_AGENT = 'codex/0.171.0';

const DEFAULT_SHARED_SERVER_CAPABILITIES: ExecutorDriverCapabilities = {
  runtimePolicyEnforcement: 'native',
  sessionApproval: true,
  interruptOnDeny: true,
  updatedToolInput: false,
  structuredInput: true,
  steer: true,
  fork: true,
  revert: true,
  compact: true,
  injectItems: true,
  backgroundWorkOutlivesTurn: false,
  multiThreadPerProcess: true,
  images: false,
  planLimits: 'pull',
};

function unexpected(stubName: string, methodName: string): () => Promise<never> {
  return async () => {
    throw new Error(`Unexpected call to ${stubName}.${methodName}()`);
  };
}

const noopClose = async (): Promise<void> => undefined;

function pickOptional<T>(
  overrides: object | undefined,
  key: string,
  value: T | undefined,
  fallback: T | undefined,
): T | undefined {
  return overrides !== undefined && key in overrides ? value : fallback;
}

function toDeltaAsyncIterable(
  deltas: readonly ExecutorDelta[] | AsyncIterable<ExecutorDelta> | undefined,
): AsyncIterable<ExecutorDelta> {
  if (deltas === undefined) {
    return {
      async *[Symbol.asyncIterator]() {
        // Empty delta stream.
      },
    };
  }
  if (Symbol.asyncIterator in deltas) {
    return deltas;
  }
  const items = [...deltas];
  return {
    async *[Symbol.asyncIterator]() {
      for (const delta of items) yield delta;
    },
  };
}

function buildCodexControlMethods(
  stubName: string,
  overrides: StubOverrides<CodexControlClient> | undefined,
): CodexControlClient {
  return {
    readConfig: overrides?.readConfig ?? unexpected(stubName, 'readConfig'),
    readThread: overrides?.readThread ?? unexpected(stubName, 'readThread'),
    listCollaborationModes:
      overrides?.listCollaborationModes ?? unexpected(stubName, 'listCollaborationModes'),
    listTurns: overrides?.listTurns ?? unexpected(stubName, 'listTurns'),
    listItems: overrides?.listItems ?? unexpected(stubName, 'listItems'),
    listMcpServerStatus:
      overrides?.listMcpServerStatus ?? unexpected(stubName, 'listMcpServerStatus'),
    listSkills: overrides?.listSkills ?? unexpected(stubName, 'listSkills'),
    listModels: overrides?.listModels ?? unexpected(stubName, 'listModels'),
    readAccount: overrides?.readAccount ?? unexpected(stubName, 'readAccount'),
    readRateLimits: overrides?.readRateLimits ?? unexpected(stubName, 'readRateLimits'),
    revertThread: overrides?.revertThread ?? unexpected(stubName, 'revertThread'),
    injectItems: overrides?.injectItems ?? unexpected(stubName, 'injectItems'),
    unsubscribeThread:
      overrides?.unsubscribeThread ?? unexpected(stubName, 'unsubscribeThread'),
    listThreads: overrides?.listThreads ?? unexpected(stubName, 'listThreads'),
    listLoadedThreads:
      overrides?.listLoadedThreads ?? unexpected(stubName, 'listLoadedThreads'),
    archiveThread: overrides?.archiveThread ?? unexpected(stubName, 'archiveThread'),
    unarchiveThread: overrides?.unarchiveThread ?? unexpected(stubName, 'unarchiveThread'),
    updateThreadMetadata:
      overrides?.updateThreadMetadata ?? unexpected(stubName, 'updateThreadMetadata'),
    setThreadName: overrides?.setThreadName ?? unexpected(stubName, 'setThreadName'),
    resumeThread: overrides?.resumeThread ?? unexpected(stubName, 'resumeThread'),
    startThreadTurn: overrides?.startThreadTurn ?? unexpected(stubName, 'startThreadTurn'),
    interruptTurn: overrides?.interruptTurn ?? unexpected(stubName, 'interruptTurn'),
    steerTurn: overrides?.steerTurn ?? unexpected(stubName, 'steerTurn'),
    compactThread: overrides?.compactThread ?? unexpected(stubName, 'compactThread'),
  };
}

/** Create a fail-loud {@link CodexControlClient} stub; every unoverridden method throws `Unexpected call to StubCodexControlClient.<method>()`. */
export function createStubCodexControlClient(
  overrides?: StubOverrides<CodexControlClient>,
): CodexControlClient {
  return buildCodexControlMethods('StubCodexControlClient', overrides);
}

/** Create a fail-loud {@link CodexControlConnection} stub with a safe no-op `close()` default. */
export function createStubCodexControlConnection(
  overrides?: StubOverrides<CodexControlConnection>,
): CodexControlConnection {
  const stubName = 'StubCodexControlConnection';
  return {
    providerPid: pickOptional(overrides, 'providerPid', overrides?.providerPid, undefined),
    userAgent: pickOptional(
      overrides,
      'userAgent',
      overrides?.userAgent,
      DEFAULT_CODEX_USER_AGENT,
    ),
    ...buildCodexControlMethods(stubName, overrides),
    respond: overrides?.respond ?? unexpected(stubName, 'respond'),
    close: overrides?.close ?? noopClose,
  };
}

/** Create a fail-loud {@link CodexSession} stub with a safe no-op `close()` default and a valid default `threadContext`. */
export function createStubCodexSession(overrides?: StubOverrides<CodexSession>): CodexSession {
  const stubName = 'StubCodexSession';
  const nativeThreadId = overrides?.nativeThreadId ?? 'stub-thread-1';
  return {
    nativeThreadId,
    providerPid: pickOptional(overrides, 'providerPid', overrides?.providerPid, undefined),
    userAgent: pickOptional(
      overrides,
      'userAgent',
      overrides?.userAgent,
      DEFAULT_CODEX_USER_AGENT,
    ),
    threadContext: overrides?.threadContext ?? {
      thread: makeCodexThreadFixture({ id: nativeThreadId }),
    },
    startTurn: overrides?.startTurn ?? unexpected(stubName, 'startTurn'),
    respond: overrides?.respond ?? unexpected(stubName, 'respond'),
    readConfig: overrides?.readConfig ?? unexpected(stubName, 'readConfig'),
    readThread: overrides?.readThread ?? unexpected(stubName, 'readThread'),
    listCollaborationModes:
      overrides?.listCollaborationModes ?? unexpected(stubName, 'listCollaborationModes'),
    listTurns: overrides?.listTurns ?? unexpected(stubName, 'listTurns'),
    listItems: overrides?.listItems ?? unexpected(stubName, 'listItems'),
    listMcpServerStatus:
      overrides?.listMcpServerStatus ?? unexpected(stubName, 'listMcpServerStatus'),
    listSkills: overrides?.listSkills ?? unexpected(stubName, 'listSkills'),
    listModels: overrides?.listModels ?? unexpected(stubName, 'listModels'),
    readAccount: overrides?.readAccount ?? unexpected(stubName, 'readAccount'),
    readRateLimits: overrides?.readRateLimits ?? unexpected(stubName, 'readRateLimits'),
    revertThread: overrides?.revertThread ?? unexpected(stubName, 'revertThread'),
    injectItems: overrides?.injectItems ?? unexpected(stubName, 'injectItems'),
    unsubscribeThread:
      overrides?.unsubscribeThread ?? unexpected(stubName, 'unsubscribeThread'),
    listThreads: overrides?.listThreads ?? unexpected(stubName, 'listThreads'),
    listLoadedThreads:
      overrides?.listLoadedThreads ?? unexpected(stubName, 'listLoadedThreads'),
    archiveThread: overrides?.archiveThread ?? unexpected(stubName, 'archiveThread'),
    unarchiveThread: overrides?.unarchiveThread ?? unexpected(stubName, 'unarchiveThread'),
    updateThreadMetadata:
      overrides?.updateThreadMetadata ?? unexpected(stubName, 'updateThreadMetadata'),
    setThreadName: overrides?.setThreadName ?? unexpected(stubName, 'setThreadName'),
    resumeThread: overrides?.resumeThread ?? unexpected(stubName, 'resumeThread'),
    startThreadTurn: overrides?.startThreadTurn ?? unexpected(stubName, 'startThreadTurn'),
    interruptTurn: overrides?.interruptTurn ?? unexpected(stubName, 'interruptTurn'),
    steerTurn: overrides?.steerTurn ?? unexpected(stubName, 'steerTurn'),
    forkThread: overrides?.forkThread ?? unexpected(stubName, 'forkThread'),
    compactThread: overrides?.compactThread ?? unexpected(stubName, 'compactThread'),
    close: overrides?.close ?? noopClose,
  };
}

/** Create a fail-loud {@link CodexSharedServer} stub with a safe no-op `close()` default. */
export function createStubCodexSharedServer(
  overrides?: StubOverrides<CodexSharedServer>,
): CodexSharedServer {
  const stubName = 'StubCodexSharedServer';
  return {
    providerPid: pickOptional(overrides, 'providerPid', overrides?.providerPid, undefined),
    userAgent: pickOptional(
      overrides,
      'userAgent',
      overrides?.userAgent,
      DEFAULT_CODEX_USER_AGENT,
    ),
    maxThreads: overrides?.maxThreads ?? 32,
    activeThreadCount: overrides?.activeThreadCount ?? 0,
    capabilities: overrides?.capabilities ?? DEFAULT_SHARED_SERVER_CAPABILITIES,
    ...buildCodexControlMethods(stubName, overrides),
    openThread: overrides?.openThread ?? unexpected(stubName, 'openThread'),
    close: overrides?.close ?? noopClose,
  };
}

/** Create a fail-loud {@link AgentEngineTurn} stub yielding `overrides.deltas` (default empty). */
export function createStubAgentEngineTurn(
  overrides?: StubAgentEngineTurnOverrides,
): AgentEngineTurn {
  const stubName = 'StubAgentEngineTurn';
  return {
    deltas: toDeltaAsyncIterable(overrides?.deltas),
    interrupt: overrides?.interrupt ?? unexpected(stubName, 'interrupt'),
    respond: overrides?.respond ?? unexpected(stubName, 'respond'),
  };
}

/** Create a fail-loud {@link CodexTurn} stub yielding `overrides.deltas` (default empty). */
export function createStubCodexTurn(overrides?: StubCodexTurnOverrides): CodexTurn {
  const stubName = 'StubCodexTurn';
  return {
    nativeTurnId: overrides?.nativeTurnId ?? 'stub-turn-1',
    deltas: toDeltaAsyncIterable(overrides?.deltas),
    interrupt: overrides?.interrupt ?? unexpected(stubName, 'interrupt'),
    respond: overrides?.respond ?? unexpected(stubName, 'respond'),
  };
}

/** Create a fail-loud {@link ClaudeSdkSession} stub with a safe no-op `close()` default. */
export function createStubClaudeSdkSession(
  overrides?: StubOverrides<ClaudeSdkSession>,
): ClaudeSdkSession {
  const stubName = 'StubClaudeSdkSession';
  return {
    nativeThreadId: overrides?.nativeThreadId ?? 'stub-session-1',
    providerPid: pickOptional(overrides, 'providerPid', overrides?.providerPid, undefined),
    startTurn: overrides?.startTurn ?? unexpected(stubName, 'startTurn'),
    setModel: overrides?.setModel ?? unexpected(stubName, 'setModel'),
    setPermissionMode:
      overrides?.setPermissionMode ?? unexpected(stubName, 'setPermissionMode'),
    applyFlagSettings:
      overrides?.applyFlagSettings ?? unexpected(stubName, 'applyFlagSettings'),
    initializationResult:
      overrides?.initializationResult ?? unexpected(stubName, 'initializationResult'),
    supportedModels: overrides?.supportedModels ?? unexpected(stubName, 'supportedModels'),
    supportedCommands:
      overrides?.supportedCommands ?? unexpected(stubName, 'supportedCommands'),
    accountInfo: overrides?.accountInfo ?? unexpected(stubName, 'accountInfo'),
    getContextUsage: overrides?.getContextUsage ?? unexpected(stubName, 'getContextUsage'),
    readUsage: overrides?.readUsage ?? unexpected(stubName, 'readUsage'),
    mcpServerStatus: overrides?.mcpServerStatus ?? unexpected(stubName, 'mcpServerStatus'),
    setMcpServers: overrides?.setMcpServers ?? unexpected(stubName, 'setMcpServers'),
    toggleMcpServer: overrides?.toggleMcpServer ?? unexpected(stubName, 'toggleMcpServer'),
    reconnectMcpServer:
      overrides?.reconnectMcpServer ?? unexpected(stubName, 'reconnectMcpServer'),
    stopTask: overrides?.stopTask ?? unexpected(stubName, 'stopTask'),
    backgroundTasks: overrides?.backgroundTasks ?? unexpected(stubName, 'backgroundTasks'),
    rewindFiles: overrides?.rewindFiles ?? unexpected(stubName, 'rewindFiles'),
    close: overrides?.close ?? noopClose,
  };
}

/** Create a fail-loud {@link AcpSession} stub with a safe no-op `close()` default. */
export function createStubAcpSession(overrides?: StubOverrides<AcpSession>): AcpSession {
  const stubName = 'StubAcpSession';
  return {
    nativeThreadId: overrides?.nativeThreadId ?? 'stub-acp-1',
    providerPid: pickOptional(overrides, 'providerPid', overrides?.providerPid, undefined),
    approvalEnforcement: overrides?.approvalEnforcement ?? 'agent-initiated',
    configOptions: overrides?.configOptions ?? [],
    title: pickOptional(overrides, 'title', overrides?.title, undefined),
    commands: overrides?.commands ?? [],
    startTurn: overrides?.startTurn ?? unexpected(stubName, 'startTurn'),
    setConfigOption: overrides?.setConfigOption ?? unexpected(stubName, 'setConfigOption'),
    respond: overrides?.respond ?? unexpected(stubName, 'respond'),
    steerTurn: overrides?.steerTurn ?? unexpected(stubName, 'steerTurn'),
    close: overrides?.close ?? noopClose,
  };
}
