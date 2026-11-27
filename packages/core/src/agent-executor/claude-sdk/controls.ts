import type {
  Options,
  PermissionMode,
  Query,
  SDKControlSetPermissionModeResponse,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { raceAbort } from '../../internal/abort-race';
import { claudeUsagePlanLimits } from '../claude/limits';
import { type PlanLimits, PlanLimitsSchema } from '../hello';
import type { ClaudeSdkRun, ClaudeSdkSession, ClaudeSdkUsageRead } from './driver';

/** Shallow-merged flag settings payload accepted by {@link ClaudeSdkSession.applyFlagSettings}. */
export type ClaudeSdkFlagSettings = Parameters<Query['applyFlagSettings']>[0];

const PermissionModeSchema = z.enum([
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'dontAsk',
  'auto',
] as const satisfies readonly PermissionMode[]);

const SetPermissionModeResponseSchema = z.looseObject({
  mode: PermissionModeSchema.optional(),
});

type LiveMethods = Omit<
  ClaudeSdkSession,
  'nativeThreadId' | 'providerPid' | 'startTurn' | 'close'
>;

/** Session state needed by live-control operations on an active Claude SDK query. */
export interface ClaudeSdkControlHost {
  readonly signal: AbortSignal;
  isClosed(): boolean;
  ensureAlive(): void;
  ensureQuery(): Promise<{ readonly query: ClaudeSdkRun }>;
  setActiveModel(model: string | undefined): void;
  setActivePermissionMode(mode: NonNullable<Options['permissionMode']>): void;
  recordFlagSettings(settings: ClaudeSdkFlagSettings): void;
  recordPlanLimits(limits: PlanLimits): void;
  recordPlanLimitsFailure(error: unknown): void;
}

/** Build a `ClaudeSdkUsageRead` for an SDK build without the experimental usage endpoint. */
export function unpublishedClaudeSdkUsageRead(now: Date = new Date()): ClaudeSdkUsageRead {
  return {
    supported: false,
    planLimits: PlanLimitsSchema.parse({
      answer: 'unpublished',
      windows: [],
      observedAt: now.toISOString(),
    }),
  };
}

/** Normalize a raw Claude SDK usage payload into a {@link ClaudeSdkUsageRead} and optionally cache known/no-plan limits. */
export function normalizeClaudeSdkUsageRead(
  raw: Extract<ClaudeSdkUsageRead, { readonly supported: true }>['raw'],
  recordPlanLimits?: (limits: PlanLimits) => void,
  now: Date = new Date(),
): ClaudeSdkUsageRead {
  const planLimits = claudeUsagePlanLimits(raw, now);
  if (planLimits.answer === 'known' || planLimits.answer === 'no-plan-limit') {
    recordPlanLimits?.(planLimits);
  }
  return { supported: true, planLimits, raw };
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
  const guarded = <T>(promise: Promise<T>): Promise<T> =>
    raceAbort(promise, host.signal).catch((error: unknown) => {
      host.ensureAlive();
      throw error;
    });
  const activeQuery = async (): Promise<ClaudeSdkRun> => {
    host.ensureAlive();
    const active = await guarded(host.ensureQuery());
    host.ensureAlive();
    return active.query;
  };

  return {
    async setModel(model) {
      const query = await activeQuery();
      await guarded(requireMethod(query, 'setModel').call(query, model));
      host.setActiveModel(model);
    },
    async setPermissionMode(mode): Promise<SDKControlSetPermissionModeResponse | undefined> {
      const query = await activeQuery();
      const raw = await guarded(requireMethod(query, 'setPermissionMode').call(query, mode));
      const parsed = SetPermissionModeResponseSchema.safeParse(raw);
      const effectiveMode =
        parsed.success && parsed.data.mode !== undefined ? parsed.data.mode : mode;
      host.setActivePermissionMode(effectiveMode);
      if (!parsed.success) return undefined;
      return parsed.data.mode !== undefined ? { mode: parsed.data.mode } : {};
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
    async readUsage(opts) {
      const query = await activeQuery();
      const fn = query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
      if (typeof fn !== 'function') {
        return unpublishedClaudeSdkUsageRead();
      }
      let raw: Awaited<ReturnType<typeof fn>>;
      try {
        raw = await guarded(fn.call(query, opts));
      } catch (error) {
        if (!host.isClosed() && !host.signal.aborted) {
          host.recordPlanLimitsFailure(error);
        }
        throw error;
      }
      host.ensureAlive();
      return normalizeClaudeSdkUsageRead(raw, host.recordPlanLimits);
    },
    async mcpServerStatus() {
      const query = await activeQuery();
      return guarded(requireMethod(query, 'mcpServerStatus').call(query));
    },
    async setMcpServers(servers) {
      const query = await activeQuery();
      return guarded(requireMethod(query, 'setMcpServers').call(query, servers));
    },
    async toggleMcpServer(serverName, enabled) {
      const query = await activeQuery();
      await guarded(requireMethod(query, 'toggleMcpServer').call(query, serverName, enabled));
    },
    async reconnectMcpServer(serverName) {
      const query = await activeQuery();
      await guarded(requireMethod(query, 'reconnectMcpServer').call(query, serverName));
    },
    async stopTask(taskId) {
      if (typeof taskId !== 'string' || taskId.trim().length === 0) {
        throw new TypeError('Claude SDK stopTask requires a non-empty taskId');
      }
      const query = await activeQuery();
      await guarded(requireMethod(query, 'stopTask').call(query, taskId));
    },
    async backgroundTasks(toolUseId) {
      if (
        toolUseId !== undefined &&
        (typeof toolUseId !== 'string' || toolUseId.trim().length === 0)
      ) {
        throw new TypeError(
          'Claude SDK backgroundTasks toolUseId must be a non-empty string when provided',
        );
      }
      const query = await activeQuery();
      return guarded(requireMethod(query, 'backgroundTasks').call(query, toolUseId));
    },
    async rewindFiles(userMessageId, options) {
      const query = await activeQuery();
      const normalized =
        options === undefined
          ? undefined
          : options.dryRun !== undefined
            ? { dryRun: options.dryRun }
            : {};
      return guarded(
        requireMethod(query, 'rewindFiles').call(query, userMessageId, normalized),
      );
    },
  };
}
