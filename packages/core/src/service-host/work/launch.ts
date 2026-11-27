import {
  type ProcessInstance,
  readProcessInstanceSync,
} from '../../internal/process-instance';
import { startNativeCommand } from '../../process/command-owner';
import type { NativeCommandOptions, NativeCommandResult } from '../../process/contract';
import { SYSTEMCTL_PATH, systemdScopeArgs } from '../systemd-inspect';
import type { SystemdScope } from '../systemd-render-shared';
import { type WorkCommand, workCommandWith } from './command';
import { WorkLaunchError } from './errors';
import { createDefaultWorkHost, type WorkHost } from './host';
import { checkWorkMembershipWith } from './membership';
import type { WorkBoundary, WorkOrigin } from './origin';
import type { WorkOwner } from './owner';
import type { WorkPlacement } from './placement';
import { assertManagerReachable } from './probe';
import { classifyManagerFailure, managerEnv } from './scope-command';

/** How long a started command may take to appear inside its scope. */
const SCOPE_ENTRY_TIMEOUT_MS = 10_000;
const SCOPE_ENTRY_POLL_MS = 10;

/**
 * The command of `launchWork`: every `runNativeCommand` option but the three the boundary
 * decides — the command always leads a process group of its own and reports its root itself.
 */
export type WorkLaunchCommand = Omit<
  NativeCommandOptions,
  'group' | 'ownerLoss' | 'onLeaderStarted'
>;

/** Input to `launchWork`: who owns the work, where it goes, and the command. */
export interface WorkLaunchInput {
  readonly owner: WorkOwner;
  readonly placement: WorkPlacement;
  readonly command: WorkLaunchCommand;
}

/** Work that is running in its boundary. */
export interface WorkLaunch {
  /** Exactly what the work's `STITCHKIT_WORK_ORIGIN` holds. */
  readonly origin: WorkOrigin;
  /** The scope, or `null` for a process root. */
  readonly unit: { readonly manager: SystemdScope; readonly name: string } | null;
  /** The process the work started as; its instance tells it from a later process with the pid. */
  readonly root: { readonly pid: number; readonly instance: ProcessInstance };
  /** Settles as `runNativeCommand` does for the root command. */
  readonly result: Promise<NativeCommandResult>;
  /**
   * Stops the whole boundary: a scope through its manager, which also ends processes that
   * left the root's group; a process root as its process group.
   */
  stop(): Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function unitLoaded(
  host: WorkHost,
  unit: NonNullable<WorkCommand['unit']>,
): Promise<boolean> {
  const result = await host.runCommand(
    SYSTEMCTL_PATH,
    systemdScopeArgs(unit.manager, [
      'show',
      '--no-pager',
      '--property=LoadState',
      '--value',
      '--',
      unit.name,
    ]),
    { env: await managerEnv(host, unit.manager) },
  );
  if (result.exitCode !== 0)
    throw new WorkLaunchError(
      classifyManagerFailure(result.stderr, unit.manager),
      `The ${unit.manager} manager did not answer for ${unit.name}: ${result.stderr.trim()}`,
      { cause: result },
    );
  return result.stdout.trim() !== 'not-found';
}

async function stopUnit(
  host: WorkHost,
  unit: NonNullable<WorkCommand['unit']>,
): Promise<void> {
  const result = await host.runCommand(
    SYSTEMCTL_PATH,
    systemdScopeArgs(unit.manager, ['stop', '--', unit.name]),
    { env: await managerEnv(host, unit.manager) },
  );
  // A scope that emptied was collected already: there is nothing left to stop.
  if (result.exitCode !== 0 && !/not loaded\.?\s*$/.test(result.stderr))
    throw new WorkLaunchError(
      'stop-failed',
      `Could not stop ${unit.name}: ${result.stderr.trim()}`,
      { cause: result },
    );
}

/** Waits until the started process is inside its scope, or the command has ended first. */
async function enteredScope(
  host: WorkHost,
  pid: number,
  boundary: WorkBoundary,
  ended: Promise<unknown>,
): Promise<boolean> {
  let over = false;
  void ended.then(
    () => {
      over = true;
    },
    () => {
      over = true;
    },
  );
  const deadline = Date.now() + SCOPE_ENTRY_TIMEOUT_MS;
  while (!over && Date.now() < deadline) {
    const membership = await checkWorkMembershipWith(host, { pid, boundary });
    if (membership.state === 'member') return true;
    if (membership.state === 'gone') return false;
    if (membership.state === 'unavailable')
      throw new WorkLaunchError(
        'membership-unavailable',
        `The scope could not be asked for its root: ${membership.reason}`,
        { cause: membership.cause },
      );
    await sleep(SCOPE_ENTRY_POLL_MS);
  }
  return false;
}

/** How the root command ended, kept as the cause of a launch that never saw its root. */
type CommandOutcome =
  | { readonly state: 'fulfilled'; readonly value: NativeCommandResult }
  | { readonly state: 'rejected'; readonly reason: unknown };

/** {@link launchWork} against an injected host. */
export async function launchWorkWith(
  host: WorkHost,
  input: WorkLaunchInput,
): Promise<WorkLaunch> {
  const { executable, args, env, ...rest } = input.command;
  const placed = await workCommandWith(host, {
    owner: input.owner,
    placement: input.placement,
    executable,
    args,
    env: env ?? {},
  });
  if (placed.unit !== null) {
    await assertManagerReachable(host, placed.unit.manager);
    if (await unitLoaded(host, placed.unit))
      throw new WorkLaunchError(
        'unit-exists',
        `${placed.unit.name} is already loaded: the id is still in use on this machine`,
      );
  }
  const started = Promise.withResolvers<{ pid: number; instance: ProcessInstance | null }>();
  const command = startNativeCommand({
    ...rest,
    executable: placed.executable,
    args: placed.args,
    env: placed.env,
    group: 'own',
    // Read at once: the root cannot have been reaped and its pid reused before this callback.
    onLeaderStarted: ({ pid }) =>
      started.resolve({ pid, instance: readProcessInstanceSync(pid) }),
  });
  const outcome = command.result.then(
    (value): CommandOutcome => ({ state: 'fulfilled', value }),
    (reason: unknown): CommandOutcome => ({ state: 'rejected', reason }),
  );
  const stop = async () => {
    if (placed.unit !== null) await stopUnit(host, placed.unit);
    await command.stop();
  };
  const refuse = async (message: string): Promise<never> => {
    await stop();
    throw new WorkLaunchError('root-unobserved', message, { cause: await outcome });
  };
  const first = await Promise.race([started.promise, outcome.then(() => null)]);
  if (first === null) return refuse('The command ended before its root was observed');
  const { pid, instance } = first;
  if (instance === null) return refuse('The root ended before its process instance was read');
  const boundary: WorkBoundary =
    placed.unit === null
      ? { kind: 'process-root', root: { pid, instance } }
      : { kind: 'transient-scope', manager: placed.unit.manager, unit: placed.unit.name };
  if (placed.unit !== null && !(await enteredScope(host, pid, boundary, command.result)))
    return refuse(`The command ended before it was seen inside ${placed.unit.name}`);
  return {
    origin: { v: 1, work: placed.work, boundary },
    unit: placed.unit,
    root: { pid, instance },
    result: command.result,
    stop,
  };
}

/**
 * Launches a command in its own boundary and resolves once its root exists there. The command
 * runs through the one native-command owner, so its signal, deadline, output and stop policy
 * mean what they mean for `runNativeCommand`; they stop the root's process group, and `stop()`
 * ends the whole boundary. Nothing is started outside the boundary that was asked for: a host
 * that cannot make it throws `WorkLaunchError` with the reason.
 */
export function launchWork(input: WorkLaunchInput): Promise<WorkLaunch> {
  return launchWorkWith(createDefaultWorkHost(), input);
}
