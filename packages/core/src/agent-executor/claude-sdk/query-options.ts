import type { Options, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import { abortReason, raceAbort } from '../../internal/abort-race';
import { assertTimerMs, withSignalDeadline } from '../../internal/deadline';
import { isPositiveSafeInteger } from '../../internal/positive-integer';
import { validateImageOptions } from '../image-input';
import { reportObserverError } from '../session-primitives';
import type { ClaudeSdkFlagSettings } from './controls';
import type {
  ClaudeSdkDelegationCheck,
  ClaudeSdkDriverConfig,
  ClaudeSdkOpenInput,
  ClaudeSdkRun,
} from './driver';
import { spawnOwnedClaudeCode } from './engine-spawn';

const DEFAULT_DELEGATION_TIMEOUT_MS = 30_000;
const FLAG_SETTINGS_REPLAY_TIMEOUT_MS = 30_000;

/** Eagerly validate driver configuration before any session or query starts. */
export function validateClaudeSdkConfig(config: ClaudeSdkDriverConfig): void {
  validateImageOptions(config);
  if (
    config.supportedDialogKinds !== undefined &&
    config.supportedDialogKinds.length > 0 &&
    config.onUserDialog === undefined
  ) {
    throw new TypeError(
      'ClaudeSdkDriverConfig.supportedDialogKinds requires onUserDialog when non-empty',
    );
  }
  if (config.verifyDelegation?.timeoutMs !== undefined) {
    assertTimerMs('verifyDelegation.timeoutMs', config.verifyDelegation.timeoutMs);
  }
}

/** Validate `open()` resume options before opening a Claude SDK session. */
export function validateClaudeSdkOpenInput(input: ClaudeSdkOpenInput): void {
  const hasNativeThreadId =
    typeof input.nativeThreadId === 'string' && input.nativeThreadId.trim().length > 0;
  if (input.resumeSessionAt !== undefined) {
    if (
      typeof input.resumeSessionAt !== 'string' ||
      input.resumeSessionAt.trim().length === 0
    ) {
      throw new TypeError(
        'Claude SDK open() requires a non-empty resumeSessionAt UUID when provided',
      );
    }
    if (!hasNativeThreadId) {
      throw new TypeError(
        'Claude SDK open() requires nativeThreadId when resumeSessionAt is provided',
      );
    }
  }
  if (input.resumeDropsTurn !== undefined) {
    if (
      typeof input.resumeDropsTurn !== 'string' ||
      input.resumeDropsTurn.trim().length === 0
    ) {
      throw new TypeError(
        'Claude SDK open() requires a non-empty resumeDropsTurn prompt UUID when provided',
      );
    }
    if (!hasNativeThreadId) {
      throw new TypeError(
        'Claude SDK open() requires nativeThreadId when resumeDropsTurn is provided',
      );
    }
    if (input.resumeSessionAt === undefined) {
      throw new TypeError(
        'Claude SDK open() requires resumeSessionAt when resumeDropsTurn is provided',
      );
    }
  }
}

/** Whether `verifyDelegation` asks the driver to run startup verification checks. */
export function hasDelegationVerification(
  check: ClaudeSdkDelegationCheck | undefined,
): check is ClaudeSdkDelegationCheck {
  return check?.requireHooksApplied === true || check?.requireNoMcpServers === true;
}

/** Read a valid positive process id from a spawned handle without type casts. */
export function readPositivePid(spawned: unknown): number | undefined {
  if (typeof spawned !== 'object' || spawned === null) return undefined;
  const raw: unknown = Reflect.get(spawned, 'pid');
  return isPositiveSafeInteger(raw) ? raw : undefined;
}

/**
 * Wrap or create `spawnClaudeCodeProcess` when either custom spawning or PID observation is
 * requested. The driver's own spawner goes through `stitchkit/process` (`spawnOwnedClaudeCode`),
 * and its process's exit is handed to `trackExit` so `close()` can wait for it; a host's own
 * spawner owns its processes, and `close()` only asks them to stop.
 */
function buildSpawnHook(
  config: ClaudeSdkDriverConfig,
  recordPid: (pid: number | undefined) => void,
  onPidExit: (pid: number) => void,
  trackExit: (exited: Promise<void>) => void,
): Options['spawnClaudeCodeProcess'] | undefined {
  const custom = config.spawnClaudeCodeProcess;
  if (custom === undefined && config.onProviderPid === undefined) return undefined;
  if (custom === undefined) {
    return (spawnOpts) => {
      let leader: number | undefined;
      const owned: { process?: SpawnedProcess } = {};
      const spawned = spawnOwnedClaudeCode(spawnOpts, {
        onStderr: config.stderr,
        onLeader: (pid) => {
          leader = pid;
          recordPid(pid);
          try {
            config.onProviderPid?.(pid);
          } catch (error) {
            reportObserverError(config.onObserverError, 'onProviderPid', error);
            // The engine never runs past a refused PID observation: stop it, the query ends.
            recordPid(undefined);
            owned.process?.kill('SIGTERM');
          }
        },
      });
      owned.process = spawned.process;
      void spawned.exited.then(() => {
        if (leader !== undefined) onPidExit(leader);
      });
      trackExit(spawned.exited);
      return spawned.process;
    };
  }
  return (spawnOpts) => {
    const proc = custom(spawnOpts);
    const pid = readPositivePid(proc);
    recordPid(pid);
    if (pid !== undefined && typeof proc.once === 'function') {
      proc.once('exit', () => onPidExit(pid));
    }
    if (pid !== undefined && config.onProviderPid !== undefined) {
      try {
        config.onProviderPid(pid);
      } catch (error) {
        try {
          proc.kill('SIGTERM');
        } catch {
          // Best-effort termination before rethrowing the callback failure.
        }
        recordPid(undefined);
        throw error;
      }
    }
    return proc;
  };
}

/** Assemble the SDK `Options` passed to `config.query` for one query lifetime. */
export function buildClaudeSdkQueryOptions(input: {
  config: ClaudeSdkDriverConfig;
  cwd: string;
  env: Record<string, string>;
  canUseTool: NonNullable<Options['canUseTool']>;
  sessionId: string;
  resume: boolean;
  resumeSessionAt?: Options['resumeSessionAt'];
  resumeDropsTurn?: Options['resumeDropsTurn'];
  activeModel: string | undefined;
  activePermissionMode: NonNullable<Options['permissionMode']>;
  recordPid: (pid: number | undefined) => void;
  onPidExit: (pid: number) => void;
  trackExit: (exited: Promise<void>) => void;
}): Options {
  const { config } = input;
  const spawnHook = buildSpawnHook(config, input.recordPid, input.onPidExit, input.trackExit);
  return {
    cwd: input.cwd,
    env: input.env,
    includePartialMessages: true,
    permissionMode: input.activePermissionMode,
    canUseTool: input.canUseTool,
    ...(input.activeModel !== undefined && { model: input.activeModel }),
    ...(config.allowDangerouslySkipPermissions !== undefined && {
      allowDangerouslySkipPermissions: config.allowDangerouslySkipPermissions,
    }),
    ...(config.pathToClaudeCodeExecutable !== undefined && {
      pathToClaudeCodeExecutable: config.pathToClaudeCodeExecutable,
    }),
    ...(config.systemPrompt !== undefined && { systemPrompt: config.systemPrompt }),
    ...(config.settingSources !== undefined && { settingSources: config.settingSources }),
    ...(config.enableFileCheckpointing !== undefined && {
      enableFileCheckpointing: config.enableFileCheckpointing,
    }),
    ...(config.supportedDialogKinds !== undefined && {
      supportedDialogKinds: [...config.supportedDialogKinds],
    }),
    ...(config.onUserDialog !== undefined && { onUserDialog: config.onUserDialog }),
    ...(config.onElicitation !== undefined && { onElicitation: config.onElicitation }),
    ...(config.hooks !== undefined && { hooks: config.hooks }),
    ...(config.tools !== undefined && { tools: config.tools }),
    ...(config.allowedTools !== undefined && { allowedTools: config.allowedTools }),
    ...(config.disallowedTools !== undefined && { disallowedTools: config.disallowedTools }),
    ...(config.mcpServers !== undefined && { mcpServers: config.mcpServers }),
    ...(config.mcpServersDelivery !== undefined && {
      mcpServersDelivery: config.mcpServersDelivery,
    }),
    ...(config.strictMcpConfig !== undefined && { strictMcpConfig: config.strictMcpConfig }),
    ...(config.plugins !== undefined && { plugins: config.plugins }),
    ...(config.agents !== undefined && { agents: config.agents }),
    ...(config.extraArgs !== undefined && { extraArgs: config.extraArgs }),
    ...(config.stderr !== undefined && { stderr: config.stderr }),
    ...(spawnHook !== undefined && { spawnClaudeCodeProcess: spawnHook }),
    ...(input.resume
      ? {
          resume: input.sessionId,
          ...(input.resumeSessionAt !== undefined && {
            resumeSessionAt: input.resumeSessionAt,
          }),
          ...(input.resumeDropsTurn !== undefined && {
            resumeDropsTurn: input.resumeDropsTurn,
          }),
        }
      : { sessionId: input.sessionId }),
  };
}

/** Fail-closed startup verification of delegation hooks and MCP isolation. */
export async function verifyClaudeSdkDelegation(
  query: ClaudeSdkRun,
  check: ClaudeSdkDelegationCheck,
  signal: AbortSignal,
): Promise<void> {
  const timeoutMs = check.timeoutMs ?? DEFAULT_DELEGATION_TIMEOUT_MS;
  await withSignalDeadline(
    timeoutMs,
    signal,
    () => new Error(`Claude SDK delegation verification timed out after ${timeoutMs} ms`),
    async (deadlineSignal) => {
      if (check.requireHooksApplied === true) {
        if (typeof query.initializationResult !== 'function') {
          throw new Error(
            'Claude SDK delegation verification requires query.initializationResult()',
          );
        }
        const initialized: unknown = await raceAbort(
          query.initializationResult(),
          deadlineSignal,
        );
        if (
          typeof initialized !== 'object' ||
          initialized === null ||
          Reflect.get(initialized, 'hooks_applied') !== true
        ) {
          throw new Error(
            'Claude SDK did not acknowledge delegation hooks (initializationResult().hooks_applied !== true)',
          );
        }
      }
      if (check.requireNoMcpServers === true) {
        if (typeof query.mcpServerStatus !== 'function') {
          throw new Error(
            'Claude SDK delegation verification requires query.mcpServerStatus()',
          );
        }
        const servers: unknown = await raceAbort(query.mcpServerStatus(), deadlineSignal);
        if (!Array.isArray(servers)) {
          throw new Error(
            'Claude SDK delegation verification refused non-array mcpServerStatus() response',
          );
        }
        if (servers.length > 0) {
          throw new Error(
            `Claude SDK exposed ${servers.length} MCP server(s) under delegated policy`,
          );
        }
      }
    },
  );
}

/** Fail-closed, timeout-bounded replay of live `applyFlagSettings` overlay on query restart. */
export async function replayClaudeSdkFlagSettings(
  query: ClaudeSdkRun,
  overlay: ClaudeSdkFlagSettings,
  signal: AbortSignal,
): Promise<void> {
  if (typeof query.applyFlagSettings !== 'function') {
    throw new Error(
      'Claude SDK cannot replay flag settings on restart: query does not support applyFlagSettings()',
    );
  }
  const applySettings = query.applyFlagSettings.bind(query);
  await withSignalDeadline(
    FLAG_SETTINGS_REPLAY_TIMEOUT_MS,
    signal,
    () =>
      new Error(
        `Claude SDK flag settings replay timed out after ${FLAG_SETTINGS_REPLAY_TIMEOUT_MS} ms`,
      ),
    (replaySignal) =>
      raceAbort(applySettings(overlay), replaySignal).catch((error: unknown) => {
        if (replaySignal.aborted) throw abortReason(replaySignal);
        throw error;
      }),
  );
}
