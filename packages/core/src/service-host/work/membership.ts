import { z } from 'zod';
import { sameProcessInstance } from '../../internal/process-instance';
import { WorkLaunchError } from './errors';
import { createDefaultWorkHost, type WorkHost } from './host';
import { readWorkOrigin, type WorkBoundary, WorkBoundarySchema } from './origin';
import type { WorkRef } from './owner';
import { unifiedControlGroup } from './scope-command';

/** Process ids are signed 32-bit integers. */
const MAX_PID = 2 ** 31 - 1;

/** How far a parent chain is followed; deeper than any real process tree. */
const MAX_ANCESTORS = 256;

/** Why a boundary could not answer whether a process belongs to it. */
export type WorkMembershipUnavailableReason =
  | 'platform-unsupported'
  | 'proc-unreadable'
  | 'cgroup-v2-required'
  | 'root-unobservable'
  | 'process-table-failed';

/**
 * Whether a process belongs to a boundary. `member` names the evidence; `outside` shows what
 * was observed instead; `gone` means no such process; `unavailable` means the boundary could
 * not be asked, with the reason and its cause — it is never read as `outside` or `member`.
 */
export type WorkMembership =
  | {
      readonly state: 'member';
      readonly via: 'cgroup' | 'root' | 'process-group' | 'ancestry';
    }
  | {
      readonly state: 'outside';
      readonly observed:
        | { readonly cgroup: string }
        | { readonly pgid: number; readonly ancestors: readonly number[] };
    }
  | { readonly state: 'gone' }
  | {
      readonly state: 'unavailable';
      readonly reason: WorkMembershipUnavailableReason;
      readonly cause: unknown;
    };

const MembershipInputSchema = z.strictObject({
  pid: z.number().int().positive().max(MAX_PID),
  boundary: WorkBoundarySchema,
});

const unavailable = (
  reason: WorkMembershipUnavailableReason,
  cause: unknown,
): WorkMembership => ({ state: 'unavailable', reason, cause });

/**
 * A scope member is a process whose control group has the unit among its path components: the
 * scope itself or a sub-group delegated below it. The comparison is by component, so it holds
 * for a reader in the host's cgroup namespace and for one inside its own.
 */
async function scopeMembership(
  host: WorkHost,
  pid: number,
  unit: string,
): Promise<WorkMembership> {
  if (host.platform !== 'linux')
    return unavailable(
      'platform-unsupported',
      new Error('A transient scope is read on Linux'),
    );
  let text: string | null;
  try {
    text = await host.readText(`/proc/${pid}/cgroup`);
  } catch (cause) {
    return unavailable('proc-unreadable', cause);
  }
  if (text === null) {
    // A missing procfs entry proves nothing while the process answers a signal: a procfs
    // mounted with hidepid hides a live process of another user.
    return (await host.liveness(pid)) === 'gone'
      ? { state: 'gone' }
      : unavailable('proc-unreadable', new Error(`/proc/${pid}/cgroup is hidden`));
  }
  // An ended process its parent has not reaped keeps a readable entry, and a removed scope's
  // path reads `… (deleted)`: it is no member of anything, and no process outside either.
  if ((await host.liveness(pid)) === 'gone') return { state: 'gone' };
  const controlGroup = unifiedControlGroup(text);
  if (controlGroup === null)
    return unavailable('cgroup-v2-required', new Error('No unified control group hierarchy'));
  return controlGroup.split('/').includes(unit)
    ? { state: 'member', via: 'cgroup' }
    : { state: 'outside', observed: { cgroup: controlGroup } };
}

type RootState = 'same' | 'reused' | 'gone';

async function observeRoot(
  host: WorkHost,
  root: Extract<WorkBoundary, { kind: 'process-root' }>['root'],
): Promise<RootState | WorkMembership> {
  const observation = await host.observeInstance(root.pid);
  if (observation.state === 'observed')
    return sameProcessInstance(observation.instance, root.instance) ? 'same' : 'reused';
  return (await host.liveness(root.pid)) === 'gone'
    ? 'gone'
    : unavailable('root-unobservable', observation.cause);
}

/**
 * A root member is the root itself, a process in the group the root leads, or a process whose
 * parent chain reaches the root while the root is still the recorded instance. A group id is not
 * reused while the group has a member, and a parent pointer always names a live process, so
 * neither can point at a stranger; a descendant that left the group and lost its parent is outside.
 */
async function rootMembership(
  host: WorkHost,
  pid: number,
  root: Extract<WorkBoundary, { kind: 'process-root' }>['root'],
): Promise<WorkMembership> {
  if (host.platform !== 'linux' && host.platform !== 'darwin')
    return unavailable(
      'platform-unsupported',
      new Error('A process root is read on Linux and macOS'),
    );
  const rootState = await observeRoot(host, root);
  if (typeof rootState !== 'string') return rootState;
  if (pid === root.pid) {
    if (rootState === 'gone') return { state: 'gone' };
    return rootState === 'same'
      ? { state: 'member', via: 'root' }
      : { state: 'outside', observed: { pgid: pid, ancestors: [] } };
  }
  const ancestors: number[] = [];
  try {
    const own = await host.lineage(pid);
    if (own === null)
      return (await host.liveness(pid)) === 'gone'
        ? { state: 'gone' }
        : unavailable('process-table-failed', new Error(`Process ${pid} is hidden`));
    if (rootState === 'reused')
      return { state: 'outside', observed: { pgid: own.pgid, ancestors } };
    if (own.pgid === root.pid) return { state: 'member', via: 'process-group' };
    if (rootState === 'gone')
      return { state: 'outside', observed: { pgid: own.pgid, ancestors } };
    let parent = own.ppid;
    while (parent > 1 && ancestors.length < MAX_ANCESTORS) {
      ancestors.push(parent);
      if (parent === root.pid) {
        // The chain was read over several moments; the root must still be the recorded process.
        const still = await observeRoot(host, root);
        if (typeof still !== 'string') return still;
        return still === 'same'
          ? { state: 'member', via: 'ancestry' }
          : { state: 'outside', observed: { pgid: own.pgid, ancestors } };
      }
      const next = await host.lineage(parent);
      if (next === null) break;
      parent = next.ppid;
    }
    return { state: 'outside', observed: { pgid: own.pgid, ancestors } };
  } catch (cause) {
    return unavailable('process-table-failed', cause);
  }
}

/** {@link checkWorkMembership} against an injected host. */
export async function checkWorkMembershipWith(
  host: WorkHost,
  input: { pid: number; boundary: WorkBoundary },
): Promise<WorkMembership> {
  const { pid, boundary } = MembershipInputSchema.parse(input);
  return boundary.kind === 'transient-scope'
    ? scopeMembership(host, pid, boundary.unit)
    : rootMembership(host, pid, boundary.root);
}

/**
 * Asks the boundary whether a process belongs to it. The variable a process carries only names
 * a boundary; this is the proof. A process that inherited the variable and then left the
 * boundary — or never was in it — answers `outside`.
 */
export function checkWorkMembership(input: {
  pid: number;
  boundary: WorkBoundary;
}): Promise<WorkMembership> {
  return checkWorkMembershipWith(createDefaultWorkHost(), input);
}

/** {@link inheritedWork} against an injected host and process. */
export async function inheritedWorkWith(host: WorkHost, pid: number): Promise<WorkRef | null> {
  const origin = readWorkOrigin(host.env);
  if (origin === null) return null;
  const membership = await checkWorkMembershipWith(host, { pid, boundary: origin.boundary });
  if (membership.state === 'member') return origin.work;
  if (membership.state === 'unavailable')
    throw new WorkLaunchError(
      'membership-unavailable',
      `The inherited boundary could not be asked: ${membership.reason}`,
      { cause: membership.cause },
    );
  return null;
}

/**
 * The work this process proves it belongs to — what a nested launcher declares as `parent` —
 * or `null` when it inherited no origin or is outside the boundary the origin names. Throws
 * `WorkLaunchError` when the variable does not parse or the boundary cannot be asked.
 */
export function inheritedWork(): Promise<WorkRef | null> {
  return inheritedWorkWith(createDefaultWorkHost(), process.pid);
}
