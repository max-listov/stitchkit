import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { Options, SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { abortReason, raceAbort } from '../../internal/abort-race';
import { assertTimerMs, withSignalDeadline } from '../../internal/deadline';
import { isPositiveSafeInteger } from '../../internal/positive-integer';
import { validateImageOptions } from '../image-input';
import type { ClaudeSdkFlagSettings } from './controls';
import type { ClaudeSdkDelegationCheck, ClaudeSdkDriverConfig, ClaudeSdkRun } from './driver';

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
 * Default process spawner used only when `onProviderPid` is configured without a custom
 * `spawnClaudeCodeProcess`. Drains `stderr` continuously with a streaming UTF-8 decoder so
 * the OS pipe cannot stall the child or split multi-byte characters, never runs a shell,
 * and forwards only the SDK's allowlisted environment and graceful signal.
 */
function createDefaultSpawner(
  stderrCallback: Options['stderr'],
): (opts: SpawnOptions) => SpawnedProcess {
  return (opts) => {
    const child = spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      env: opts.env,
      signal: opts.signal,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    if (child.stderr !== null) {
      const decoder = new StringDecoder('utf8');
      const emit = (text: string) => {
        if (text.length === 0 || stderrCallback === undefined) return;
        try {
          stderrCallback(text);
        } catch {
          // A failing diagnostics callback must not crash the stderr drain loop.
        }
      };
      child.stderr.on('error', () => undefined);
      child.stderr.on('data', (chunk: Buffer | string) => {
        emit(typeof chunk === 'string' ? chunk : decoder.write(chunk));
      });
      child.stderr.on('end', () => {
        emit(decoder.end());
      });
    }
    return child;
  };
}

/** Wrap or create `spawnClaudeCodeProcess` when either custom spawning or PID observation is requested. */
function buildSpawnHook(
  config: ClaudeSdkDriverConfig,
  recordPid: (pid: number | undefined) => void,
  onPidExit: (pid: number) => void,
): Options['spawnClaudeCodeProcess'] | undefined {
  if (config.spawnClaudeCodeProcess === undefined && config.onProviderPid === undefined) {
    return undefined;
  }
  const baseSpawner = config.spawnClaudeCodeProcess ?? createDefaultSpawner(config.stderr);
  return (spawnOpts) => {
    const proc = baseSpawner(spawnOpts);
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
}): Options {
  const { config } = input;
  const spawnHook = buildSpawnHook(config, input.recordPid, input.onPidExit);
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
