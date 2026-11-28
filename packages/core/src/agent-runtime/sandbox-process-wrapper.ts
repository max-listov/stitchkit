import { abortReason } from '../internal/abort-race';
import { runNativeCommand } from '../process/command';
import { SandboxError } from './sandbox-contract';
import {
  buildLinuxBubblewrapCommand,
  DEFAULT_BWRAP_EXECUTABLE,
} from './sandbox-process-linux';
import { buildMacOsSeatbeltCommand } from './sandbox-process-macos';
import {
  assertProcessSandboxCommand,
  type ProcessSandbox,
  type ProcessSandboxBackendKind,
  type ProcessSandboxCommandSpec,
  type ProcessSandboxProbeOptions,
  type ProcessSandboxProbeResult,
  type ProcessSandboxSpec,
  ProcessSandboxSpecSchema,
} from './sandbox-process-spec';

const DEFAULT_SANDBOX_EXEC = '/usr/bin/sandbox-exec';
const PROBE_TIMEOUT_MS = 5_000;
const PROBE_MAX_OUTPUT_BYTES = 64 * 1024;

function backendForPlatform(platform: NodeJS.Platform): ProcessSandboxBackendKind {
  if (platform === 'linux') return 'bwrap';
  if (platform === 'darwin') return 'seatbelt';
  return 'unsupported';
}

function failureDetail(
  stderr: Uint8Array,
  exitCode: number | null,
  signal: string | null,
): string {
  const text = new TextDecoder().decode(stderr).trim();
  if (text.length > 0) return text;
  if (signal !== null) return `terminated by signal ${signal}`;
  return `exited with code ${exitCode ?? 'unknown'}`;
}

/**
 * Probe whether the host OS can establish a fail-closed process sandbox (`bwrap` on Linux,
 * `sandbox-exec` Seatbelt on macOS). Never throws on unavailability: returns a discriminated verdict.
 */
export async function probeProcessSandbox(
  options: ProcessSandboxProbeOptions = {},
): Promise<ProcessSandboxProbeResult> {
  if (options.signal?.aborted) throw abortReason(options.signal);
  const platform = options.platform ?? process.platform;
  const backend = backendForPlatform(platform);

  if (backend === 'bwrap') {
    const executable = options.bwrapExecutable ?? DEFAULT_BWRAP_EXECUTABLE;
    try {
      const result = await runNativeCommand({
        executable,
        args: [
          '--unshare-all',
          '--die-with-parent',
          '--new-session',
          '--cap-drop',
          'ALL',
          '--ro-bind',
          '/usr',
          '/usr',
          '--ro-bind',
          '/lib',
          '/lib',
          '--ro-bind-try',
          '/lib64',
          '/lib64',
          '--symlink',
          'usr/bin',
          '/bin',
          '--proc',
          '/proc',
          '--dev',
          '/dev',
          '--tmpfs',
          '/tmp',
          '--',
          '/bin/true',
        ],
        envPolicy: 'declared-only',
        env: {},
        capture: true,
        maxOutputBytes: PROBE_MAX_OUTPUT_BYTES,
        timeoutMs: PROBE_TIMEOUT_MS,
        ...(options.signal !== undefined && { signal: options.signal }),
      });
      if (result.exitCode === 0) {
        return { available: true, backend: 'bwrap', executable };
      }
      return {
        available: false,
        backend: 'bwrap',
        reason: `Bubblewrap probe failed (${executable}): ${failureDetail(result.stderr, result.exitCode, result.signal)}`,
      };
    } catch (error) {
      if (options.signal?.aborted) throw abortReason(options.signal);
      return {
        available: false,
        backend: 'bwrap',
        reason: `Bubblewrap unavailable (${executable}): ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  if (backend === 'seatbelt') {
    const executable = options.sandboxExecExecutable ?? DEFAULT_SANDBOX_EXEC;
    try {
      const result = await runNativeCommand({
        executable,
        args: ['-p', '(version 1)(allow default)', '--', '/usr/bin/true'],
        envPolicy: 'declared-only',
        env: {},
        capture: true,
        maxOutputBytes: PROBE_MAX_OUTPUT_BYTES,
        timeoutMs: PROBE_TIMEOUT_MS,
        ...(options.signal !== undefined && { signal: options.signal }),
      });
      if (result.exitCode === 0) {
        return { available: true, backend: 'seatbelt', executable };
      }
      return {
        available: false,
        backend: 'seatbelt',
        reason: `Seatbelt probe failed (${executable}): ${failureDetail(result.stderr, result.exitCode, result.signal)}`,
      };
    } catch (error) {
      if (options.signal?.aborted) throw abortReason(options.signal);
      return {
        available: false,
        backend: 'seatbelt',
        reason: `Seatbelt unavailable (${executable}): ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  return {
    available: false,
    backend: 'unsupported',
    reason: `OS process sandbox is not supported on platform "${platform}"`,
  };
}

/**
 * Create a reusable fail-closed OS process sandbox wrapper for long-lived streaming stdio/IPC
 * processes (`workspace-strict` or `workspace-readonly`). Its `wrapCommand` method plugs directly
 * into `AcpDriverConfig.wrapCommand` and `CodexDriverConfig.wrapCommand`.
 *
 * On Linux (`bwrap`), only explicitly mounted paths exist inside the mount namespace; on macOS
 * Seatbelt (`sandbox-exec`), writes are denied by default while reads remain allowed except for
 * explicit `denyPaths`.
 */
export function createProcessSandbox(
  rawSpec: ProcessSandboxSpec,
  options: { readonly platform?: NodeJS.Platform | undefined } = {},
): ProcessSandbox {
  const spec = ProcessSandboxSpecSchema.parse(rawSpec);
  const platform = options.platform ?? process.platform;
  const backend = backendForPlatform(platform);
  let verifiedAvailable = false;

  const probe = (probeOptions?: {
    readonly signal?: AbortSignal | undefined;
  }): Promise<ProcessSandboxProbeResult> =>
    probeProcessSandbox({
      ...(spec.bwrapExecutable !== undefined && { bwrapExecutable: spec.bwrapExecutable }),
      ...(spec.sandboxExecExecutable !== undefined && {
        sandboxExecExecutable: spec.sandboxExecExecutable,
      }),
      platform,
      ...(probeOptions?.signal !== undefined && { signal: probeOptions.signal }),
    });

  const wrapCommand = async (
    command: ProcessSandboxCommandSpec,
  ): Promise<ProcessSandboxCommandSpec> => {
    assertProcessSandboxCommand(command);
    if (command.signal?.aborted) throw abortReason(command.signal);
    if (!verifiedAvailable) {
      const verdict = await probe({ signal: command.signal });
      if (!verdict.available) {
        throw new SandboxError('SANDBOX_UNAVAILABLE', verdict.reason);
      }
      verifiedAvailable = true;
    }
    if (command.signal?.aborted) throw abortReason(command.signal);
    if (backend === 'bwrap') {
      return buildLinuxBubblewrapCommand(spec, command);
    }
    if (backend === 'seatbelt') {
      return buildMacOsSeatbeltCommand(spec, command);
    }
    throw new SandboxError(
      'SANDBOX_UNAVAILABLE',
      `OS process sandbox is not supported on platform "${platform}"`,
    );
  };

  return {
    profile: spec.profile,
    backend,
    probe,
    wrapCommand,
  };
}
