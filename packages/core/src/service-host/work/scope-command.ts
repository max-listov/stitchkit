import type { SystemdScope } from '../systemd-render-shared';
import { WorkLaunchError, type WorkLaunchErrorReason } from './errors';
import type { WorkHost } from './host';
import { type WorkRef, WorkRefSchema } from './owner';
import type { WorkScopeLimits } from './placement';

/** Absolute path of `systemd-run`, where the systemd package installs it. */
export const SYSTEMD_RUN_PATH = '/usr/bin/systemd-run';

/**
 * The first systemd whose `systemd-run` takes `--expand-environment=`. Without that option a
 * scope command has every `$` in its arguments expanded by `systemd-run` itself (systemd-run(1),
 * "--expand-environment=BOOL … Added in version 254").
 */
export const MIN_SYSTEMD_VERSION = 254;

/**
 * The scope unit of one piece of work: `<launcher>-<id>.scope`, from a reference or a whole
 * owner record. One way only — the name is never parsed back, because two different owners
 * can spell the same name.
 */
export function workUnitName(work: WorkRef): string {
  const ref = WorkRefSchema.parse({ launcher: work.launcher, id: work.id });
  return `${ref.launcher}-${ref.id}.scope`;
}

/** The single-hierarchy line of `/proc/<pid>/cgroup`, or `null` on a host without cgroup v2. */
export function unifiedControlGroup(text: string): string | null {
  for (const line of text.split('\n')) if (line.startsWith('0::')) return line.slice(3);
  return null;
}

const USER_MANAGER_UNIT = /^user@\d+\.service$/;

/**
 * The caller's own slice under one manager: the last `*.slice` component of its control group
 * that this manager owns. Under the user manager only what follows `user@<uid>.service` counts,
 * under the system manager only what precedes it.
 */
export function callerSlice(controlGroup: string, manager: SystemdScope): string | null {
  const components = controlGroup.split('/').filter((part) => part.length > 0);
  const userManager = components.findIndex((part) => USER_MANAGER_UNIT.test(part));
  const owned =
    manager === 'user'
      ? userManager < 0
        ? []
        : components.slice(userManager + 1)
      : userManager < 0
        ? components
        : components.slice(0, userManager);
  return owned.findLast((part) => part.endsWith('.slice')) ?? null;
}

/** Resolves `slice: 'caller'` from the caller's own control group. */
export async function resolveCallerSlice(
  host: WorkHost,
  manager: SystemdScope,
): Promise<string> {
  const text = await host.readText('/proc/self/cgroup');
  const controlGroup = text === null ? null : unifiedControlGroup(text);
  const slice = controlGroup === null ? null : callerSlice(controlGroup, manager);
  if (slice === null)
    throw new WorkLaunchError(
      'slice-unresolvable',
      `The caller has no slice of its own under the ${manager} manager; name the slice`,
      { cause: { controlGroup } },
    );
  return slice;
}

/**
 * What `systemd-run --user` and `systemctl --user` need to reach the caller's manager outside a
 * login session: the caller's `XDG_RUNTIME_DIR`, or `/run/user/<uid>` when that directory is the
 * caller's own.
 */
export async function userManagerEnv(host: WorkHost): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  const bus = host.env.DBUS_SESSION_BUS_ADDRESS;
  if (bus !== undefined) env.DBUS_SESSION_BUS_ADDRESS = bus;
  const declared = host.env.XDG_RUNTIME_DIR;
  if (declared !== undefined && declared.length > 0)
    return { ...env, XDG_RUNTIME_DIR: declared };
  const runtimeDir = host.uid === null ? null : `/run/user/${host.uid}`;
  if (runtimeDir !== null && (await host.directoryOwner(runtimeDir)) === host.uid)
    return { ...env, XDG_RUNTIME_DIR: runtimeDir };
  throw new WorkLaunchError(
    'user-manager-unreachable',
    'No XDG_RUNTIME_DIR and no runtime directory of the caller: its user manager cannot be reached',
    { cause: { runtimeDir } },
  );
}

/** The environment a manager command needs for one manager. */
export async function managerEnv(
  host: WorkHost,
  manager: SystemdScope,
): Promise<Record<string, string>> {
  return manager === 'user' ? userManagerEnv(host) : {};
}

/** Names what a failed `systemd-run` or `systemctl` said, by the text systemd prints. */
export function classifyManagerFailure(
  stderr: string,
  manager: SystemdScope,
): WorkLaunchErrorReason {
  if (stderr.includes('not been booted with systemd')) return 'systemd-unavailable';
  if (/Failed to connect to (?:\w+ )*bus/.test(stderr))
    return manager === 'user' ? 'user-manager-unreachable' : 'manager-unreachable';
  if (stderr.includes('was already loaded or has a fragment file')) return 'unit-exists';
  return 'scope-refused';
}

/** `systemd 259 (259.9-0ubuntu0.1)` → 259. */
export function parseSystemdVersion(stdout: string): number | null {
  const match = /^systemd (\d+)\b/.exec(stdout);
  return match ? Number(match[1]) : null;
}

/**
 * Refuses a host whose `systemd-run` is absent or older than {@link MIN_SYSTEMD_VERSION}; the
 * version is asked of `systemd-run` itself, never assumed.
 */
export async function assertSystemdRunVersion(host: WorkHost): Promise<number> {
  if (host.platform !== 'linux')
    throw new WorkLaunchError(
      'platform-unsupported',
      'A transient scope needs Linux with systemd',
    );
  let result: Awaited<ReturnType<WorkHost['runCommand']>>;
  try {
    result = await host.runCommand(SYSTEMD_RUN_PATH, ['--version']);
  } catch (cause) {
    throw new WorkLaunchError('systemd-unavailable', `${SYSTEMD_RUN_PATH} could not run`, {
      cause,
    });
  }
  const version = result.exitCode === 0 ? parseSystemdVersion(result.stdout) : null;
  if (version === null)
    throw new WorkLaunchError(
      'systemd-unavailable',
      'systemd-run did not report its version',
      {
        cause: result,
      },
    );
  if (version < MIN_SYSTEMD_VERSION)
    throw new WorkLaunchError(
      'systemd-too-old',
      `systemd ${version} is older than ${MIN_SYSTEMD_VERSION}: its systemd-run cannot pass a command's arguments unexpanded`,
      { cause: { version, required: MIN_SYSTEMD_VERSION } },
    );
  return version;
}

function limitProperties(limits: WorkScopeLimits | undefined): string[] {
  if (limits === undefined) return [];
  const properties: string[] = [];
  if (limits.memoryMaxMb !== undefined) properties.push(`MemoryMax=${limits.memoryMaxMb}M`);
  if (limits.memorySwapMaxMb !== undefined)
    properties.push(`MemorySwapMax=${limits.memorySwapMaxMb}M`);
  if (limits.cpuQuotaPercent !== undefined)
    properties.push(`CPUQuota=${limits.cpuQuotaPercent}%`);
  if (limits.cpuWeight !== undefined) properties.push(`CPUWeight=${limits.cpuWeight}`);
  if (limits.runtimeMaxSeconds !== undefined)
    properties.push(`RuntimeMaxSec=${limits.runtimeMaxSeconds}`);
  return properties.map((property) => `--property=${property}`);
}

/**
 * Arguments of the `systemd-run` that starts a command in its scope. `--expand-environment=no`
 * hands every argument to the command as written; `--collect` frees the unit name once the
 * scope is empty, whether it ended well or not.
 */
export function scopeCommandArgs(input: {
  manager: SystemdScope;
  unit: string;
  description: string;
  slice: string;
  limits: WorkScopeLimits | undefined;
  executable: string;
  args: readonly string[];
}): string[] {
  return [
    ...(input.manager === 'user' ? ['--user'] : []),
    '--scope',
    '--quiet',
    '--collect',
    '--expand-environment=no',
    `--unit=${input.unit}`,
    `--description=${input.description}`,
    `--slice=${input.slice}`,
    ...limitProperties(input.limits),
    '--',
    input.executable,
    ...input.args,
  ];
}
