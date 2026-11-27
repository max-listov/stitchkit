import { SYSTEMCTL_PATH, systemdScopeArgs } from '../systemd-inspect';
import { WorkLaunchError, type WorkLaunchErrorReason } from './errors';
import { createDefaultWorkHost, type WorkHost } from './host';
import { type WorkPlacement, WorkPlacementSchema } from './placement';
import {
  assertSystemdRunVersion,
  classifyManagerFailure,
  managerEnv,
  resolveCallerSlice,
} from './scope-command';

/** Whether a host can make the asked boundary, and when not, the named reason with its cause. */
export type WorkBoundaryAvailability =
  | { readonly state: 'available' }
  | {
      readonly state: 'unavailable';
      readonly reason: WorkLaunchErrorReason;
      readonly cause: unknown;
    };

/** Refuses unless the manager answers; a refusal names why by what the manager printed. */
export async function assertManagerReachable(
  host: WorkHost,
  manager: 'system' | 'user',
): Promise<void> {
  const env = await managerEnv(host, manager);
  let result: Awaited<ReturnType<WorkHost['runCommand']>>;
  try {
    result = await host.runCommand(
      SYSTEMCTL_PATH,
      systemdScopeArgs(manager, ['show', '--no-pager', '--property=Version', '--value']),
      { env },
    );
  } catch (cause) {
    throw new WorkLaunchError('systemd-unavailable', `${SYSTEMCTL_PATH} could not run`, {
      cause,
    });
  }
  if (result.exitCode !== 0) {
    const reason = classifyManagerFailure(result.stderr, manager);
    throw new WorkLaunchError(
      reason === 'scope-refused' ? 'manager-unreachable' : reason,
      `The ${manager} manager did not answer: ${result.stderr.trim()}`,
      { cause: result },
    );
  }
}

/** {@link probeWorkBoundary} against an injected host. */
export async function probeWorkBoundaryWith(
  host: WorkHost,
  input: WorkPlacement,
): Promise<WorkBoundaryAvailability> {
  const placement = WorkPlacementSchema.parse(input);
  try {
    if (placement.kind === 'process-root') {
      if (host.platform !== 'linux' && host.platform !== 'darwin')
        throw new WorkLaunchError(
          'platform-unsupported',
          'A process root needs Linux or macOS',
        );
      if (!host.canReplaceProcess)
        throw new WorkLaunchError(
          'platform-unsupported',
          'A process root needs a runtime with process.execve',
        );
      const own = await host.observeInstance(process.pid);
      if (own.state !== 'observed')
        throw new WorkLaunchError(
          'root-unobservable',
          'This host cannot observe a process instance',
          { cause: own.cause },
        );
      return { state: 'available' };
    }
    await assertSystemdRunVersion(host);
    await assertManagerReachable(host, placement.manager);
    if (placement.slice === 'caller') await resolveCallerSlice(host, placement.manager);
    return { state: 'available' };
  } catch (error) {
    if (error instanceof WorkLaunchError)
      return { state: 'unavailable', reason: error.reason, cause: error };
    throw error;
  }
}

/**
 * Asks the host, without launching anything, whether it can make a boundary: a transient scope
 * needs Linux, a `systemd-run` of version 254 or newer, a manager that answers and — for
 * `slice: 'caller'` — a slice of the caller's own; a process root needs Linux or macOS and a
 * runtime that can replace its process image. Whether the manager then admits one particular
 * scope is answered by the launch itself.
 */
export function probeWorkBoundary(
  placement: WorkPlacement,
): Promise<WorkBoundaryAvailability> {
  return probeWorkBoundaryWith(createDefaultWorkHost(), placement);
}
