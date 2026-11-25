import {
  foreignUnitSource,
  SYSTEMCTL_PATH,
  type SystemdHostAdapter,
  type SystemdUnitCheckResult,
  systemdScopeArgs,
} from './systemd-inspect';
import {
  differentLinks,
  type EnablementLinks,
  readEnablementLinks,
  restoreEnablementLinks,
} from './systemd-links';
import { type SystemdScope, SystemdUnitError } from './systemd-render-shared';

/** Execute a `systemctl` command and fail closed on non-zero exit status. */
export async function runSystemctlChecked(
  adapter: SystemdHostAdapter,
  scope: SystemdScope,
  args: readonly string[],
): Promise<void> {
  const result = await adapter.runCommand(SYSTEMCTL_PATH, systemdScopeArgs(scope, args));
  if (result.exitCode !== 0) {
    throw new SystemdUnitError(
      'COMMAND_FAILED',
      `systemctl ${args.join(' ')} failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
    );
  }
}

/** Refuse to overwrite a symlink or non-regular file at a managed unit destination path. */
export function assertOwnedRegularPath(
  unitName: string,
  unitPath: string,
  standing: Awaited<ReturnType<SystemdHostAdapter['inspectPath']>>,
): void {
  if (standing.kind === 'symlink' || standing.kind === 'other') {
    throw new SystemdUnitError(
      'FOREIGN_FRAGMENT',
      `Refusing to manage ${unitName}: ${unitPath} is ${standing.kind === 'symlink' ? `a symbolic link to ${standing.target}` : 'not a regular file'}, not a unit file of ours to replace`,
      { rolledBack: false },
    );
  }
}

/** Refuse to manage a unit when foreign drop-ins or another fragment source own it. */
export function assertNoForeignUnit(
  unitName: string,
  unitPath: string,
  check: SystemdUnitCheckResult,
): void {
  if (check.foreignDropIns.length > 0) {
    throw new SystemdUnitError(
      'FOREIGN_DROP_IN',
      `Refusing to manage ${unitName}: foreign drop-ins present (${check.foreignDropIns.join(', ')})`,
      { rolledBack: false, foreignDropIns: check.foreignDropIns },
    );
  }
  const foreign = foreignUnitSource(check, unitPath);
  if (foreign !== undefined) {
    throw new SystemdUnitError(
      'FOREIGN_FRAGMENT',
      `Refusing to manage ${unitName}: ${foreign}`,
      { rolledBack: false },
    );
  }
}

/** State required to verify and restore a unit's enablement links during rollback. */
export interface UnitEnablementRollback {
  scope: SystemdScope;
  unitName: string;
  previousBytes: Uint8Array | null;
  previousUnitFileState: string | null;
  linkDirs: readonly string[];
  linkNames: ReadonlySet<string>;
  linksBefore: EnablementLinks;
}

/**
 * Put back the enablement an apply's `enable` changed and check it on disk: every link
 * `enable` added is removed, the unit's links must then be the ones found before the apply,
 * and `is-enabled` must read the `UnitFileState` found then.
 */
export async function restoreUnitEnablement(
  adapter: SystemdHostAdapter,
  point: UnitEnablementRollback,
): Promise<void> {
  const { scope, unitName } = point;
  const read = () => readEnablementLinks(adapter, point.linkDirs, point.linkNames);
  if (await restoreEnablementLinks(adapter, unitName, point.linksBefore, await read())) {
    await runSystemctlChecked(adapter, scope, ['daemon-reload']);
  }
  const differ = differentLinks(point.linksBefore, await read());
  if (differ.length > 0) {
    throw new SystemdUnitError(
      'COMMAND_FAILED',
      `the enable links of ${unitName} differ from before the apply: ${differ.join(', ')}`,
    );
  }
  if (point.previousBytes === null) return;
  const expected = point.previousUnitFileState;
  if (expected === null) {
    throw new SystemdUnitError(
      'COMMAND_FAILED',
      `UnitFileState of ${unitName} was unknown before the apply: its enablement cannot be checked`,
    );
  }
  const result = await adapter.runCommand(
    SYSTEMCTL_PATH,
    systemdScopeArgs(scope, ['is-enabled', '--', unitName]),
  );
  const state = result.stdout.trim();
  if (state !== expected) {
    throw new SystemdUnitError(
      'COMMAND_FAILED',
      `UnitFileState of ${unitName} is ${state || 'unknown'} after rollback, not ${expected}${result.stderr.trim() ? ` (${result.stderr.trim()})` : ''}`,
    );
  }
}
