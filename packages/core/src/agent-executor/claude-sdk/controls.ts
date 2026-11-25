import type { Options, Query } from '@anthropic-ai/claude-agent-sdk';
import { raceAbort } from '../../internal/abort-race';
import type { ClaudeSdkRun, ClaudeSdkSession } from './driver';

export type ClaudeSdkFlagSettings = Parameters<Query['applyFlagSettings']>[0];

type LiveMethods = Omit<
  ClaudeSdkSession,
  'nativeThreadId' | 'providerPid' | 'startTurn' | 'close'
>;

/** Session state needed by live-control operations on an active Claude SDK query. */
export interface ClaudeSdkControlHost {
  readonly signal: AbortSignal;
  isClosed(): boolean;
  ensureQuery(): Promise<{ readonly query: ClaudeSdkRun }>;
  setActiveModel(model: string | undefined): void;
  setActivePermissionMode(mode: NonNullable<Options['permissionMode']>): void;
  recordFlagSettings(settings: ClaudeSdkFlagSettings): void;
}

function requireMethod<K extends keyof ClaudeSdkRun>(
  query: ClaudeSdkRun,
  name: K,
): NonNullable<ClaudeSdkRun[K]> {
  const fn = query[name];
  if (typeof fn !== 'function') {
    throw new Error(`The configured Claude SDK query does not support ${String(name)}()`);
  }
  return fn;
}

/** Create the live-session control and inspection methods exposed on {@link ClaudeSdkSession}. */
export function createClaudeSdkControls(host: ClaudeSdkControlHost): LiveMethods {
  const activeQuery = async (): Promise<ClaudeSdkRun> => {
    if (host.isClosed()) throw new Error('The Claude SDK session is closed');
    const active = await raceAbort(host.ensureQuery(), host.signal);
    if (host.isClosed()) throw new Error('The Claude SDK session is closed');
    return active.query;
  };
  const guarded = <T>(promise: Promise<T>): Promise<T> => raceAbort(promise, host.signal);

  return {
    async setModel(model) {
      const query = await activeQuery();
      await guarded(requireMethod(query, 'setModel').call(query, model));
      host.setActiveModel(model);
    },
    async setPermissionMode(mode) {
      const query = await activeQuery();
      await guarded(requireMethod(query, 'setPermissionMode').call(query, mode));
      host.setActivePermissionMode(mode);
    },
    async applyFlagSettings(settings) {
      const query = await activeQuery();
      await guarded(requireMethod(query, 'applyFlagSettings').call(query, settings));
      host.recordFlagSettings(settings);
    },
    async initializationResult() {
      const query = await activeQuery();
      return guarded(requireMethod(query, 'initializationResult').call(query));
    },
    async supportedModels() {
      const query = await activeQuery();
      return guarded(requireMethod(query, 'supportedModels').call(query));
    },
    async supportedCommands() {
      const query = await activeQuery();
      return guarded(requireMethod(query, 'supportedCommands').call(query));
    },
    async accountInfo() {
      const query = await activeQuery();
      return guarded(requireMethod(query, 'accountInfo').call(query));
    },
    async getContextUsage(opts) {
      const query = await activeQuery();
      return guarded(requireMethod(query, 'getContextUsage').call(query, opts));
    },
    async mcpServerStatus() {
      const query = await activeQuery();
      return guarded(requireMethod(query, 'mcpServerStatus').call(query));
    },
    async toggleMcpServer(serverName, enabled) {
      const query = await activeQuery();
      await guarded(requireMethod(query, 'toggleMcpServer').call(query, serverName, enabled));
    },
    async reconnectMcpServer(serverName) {
      const query = await activeQuery();
      await guarded(requireMethod(query, 'reconnectMcpServer').call(query, serverName));
    },
    async rewindFiles(userMessageId, options) {
      const query = await activeQuery();
      return guarded(requireMethod(query, 'rewindFiles').call(query, userMessageId, options));
    },
  };
}
