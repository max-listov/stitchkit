import type { ClaudeSdkSession } from '../claude-sdk/driver';
import { noopClose, pickOptional, type StubOverrides, unexpected } from './consumer-stubs';

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
