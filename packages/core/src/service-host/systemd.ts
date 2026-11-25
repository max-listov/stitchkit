import { messageOf } from '../internal/error-message';
import { computeSha256Hex } from './artifact-manifest';
import {
  assertValidSystemdUnitName,
  checkSystemdUnit,
  createDefaultSystemdHostAdapter,
  DEFAULT_SYSTEMD_UNIT_MODE,
  foreignUnitSource,
  resolveUnitSearchDirs,
  SYSTEMCTL_PATH,
  type SystemdHostAdapter,
  systemdMainPid,
  systemdScopeArgs,
  systemdUnitActive,
} from './systemd-inspect';
import {
  differentLinks,
  type EnablementLinks,
  enablementNamesOf,
  readEnablementLinks,
  restoreEnablementLinks,
} from './systemd-links';
import { type SystemdScope, SystemdUnitError } from './systemd-render';

const DEFAULT_STABILITY_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const MAX_WAIT_MS = 300_000;

/** Options for {@link installAndStartSystemdUnit} and {@link reloadSystemdUnit}. */
export interface ApplySystemdUnitOptions {
  /** Unit name such as `example.service`. */
  unitName: string;
  /** Destination path for the `.service` unit file. */
  unitPath: string;
  /** Rendered `.service` content to install. */
  content: string;
  /** Systemd manager scope (`'system'` or `'user'`). */
  scope: SystemdScope;
  /** File mode applied atomically to the unit file (default: `0o644`). */
  mode?: number;
  /**
   * Whether to run `systemctl enable` before restarting. A rollback puts the enablement
   * back — `disable` for a unit that was `disabled` or `static`, `reenable` from the restored
   * bytes for one `enabled` under another `[Install]` section — and answers `rolledBack: true`
   * only when `is-enabled` then reads the state found before the apply.
   */
  enable?: boolean;
  /** Duration the new MainPID must stay active unchanged (default: 5,000 ms; 0 skips wait). */
  stabilityMs?: number;
  /** Polling interval during startup and stability checks (default: 250 ms). */
  pollIntervalMs?: number;
  /** Maximum time to wait for the unit to become active with a MainPID (default: 10,000 ms). */
  startupTimeoutMs?: number;
  /** Additional directories to scan for foreign `<unitName>.d/*.conf` drop-ins. */
  unitSearchDirs?: readonly string[];
  /** Custom host adapter; defaults to the real Linux systemd adapter. */
  adapter?: SystemdHostAdapter;
}

/** Result returned when {@link installAndStartSystemdUnit} or {@link reloadSystemdUnit} succeeds. */
export interface SystemdApplyResult {
  unitName: string;
  digest: string;
  mainPid: number;
  stableForMs: number;
}

function assertSystemdWaitMs(name: string, value: number, allowZero: boolean): void {
  const min = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(value) || value < min || value > MAX_WAIT_MS) {
    throw new SystemdUnitError(
      'INVALID_CONFIG',
      `Invalid ${name}: expected integer in [${min}, ${MAX_WAIT_MS}], got ${value}`,
    );
  }
}

async function runSystemctlChecked(
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

async function waitForStableSystemdUnit(
  unitName: string,
  scope: SystemdScope,
  adapter: SystemdHostAdapter,
  startupTimeoutMs: number,
  stabilityMs: number,
  pollIntervalMs: number,
): Promise<{ mainPid: number; stableForMs: number }> {
  const startDeadline = adapter.now() + startupTimeoutMs;
  let candidatePid: number | null = null;

  for (;;) {
    const active = await systemdUnitActive({ unitName, scope, adapter });
    const pid = active ? await systemdMainPid({ unitName, scope, adapter }) : null;
    if (active && pid !== null) {
      candidatePid = pid;
      break;
    }
    if (adapter.now() >= startDeadline) {
      throw new SystemdUnitError(
        'START_TIMEOUT',
        `Systemd unit ${unitName} did not reach active state with MainPID within ${startupTimeoutMs}ms`,
      );
    }
    await adapter.sleep(Math.min(pollIntervalMs, Math.max(1, startDeadline - adapter.now())));
  }

  const stableSince = adapter.now();
  const stableDeadline = stableSince + stabilityMs;
  while (adapter.now() < stableDeadline) {
    await adapter.sleep(Math.min(pollIntervalMs, Math.max(1, stableDeadline - adapter.now())));
    const active = await systemdUnitActive({ unitName, scope, adapter });
    const pid = active ? await systemdMainPid({ unitName, scope, adapter }) : null;
    if (!active || pid !== candidatePid) {
      throw new SystemdUnitError(
        'UNSTABLE_CANDIDATE',
        `Systemd unit ${unitName} lost stability during ${stabilityMs}ms window (expected PID ${candidatePid}, observed ${pid ?? 'none'})`,
      );
    }
  }

  return { mainPid: candidatePid, stableForMs: adapter.now() - stableSince };
}

const ONESHOT_TYPE = /^[ \t]*Type[ \t]*=[ \t]*oneshot[ \t]*$/m;

/** What a failed apply found before it changed anything, and what it went on to change. */
interface SystemdRollbackPoint {
  mode: number;
  previousBytes: Uint8Array | null;
  wasActive: boolean;
  previousUnitFileState: string | null;
  /** The directories the unit's enable links live in, and those links before the apply. */
  linkDirs: readonly string[];
  linkNames: ReadonlySet<string>;
  linksBefore: EnablementLinks;
  didEnable: boolean;
  didRestart: boolean;
}

/**
 * Put back the enablement an apply's `enable` changed and check it on disk: every link
 * `enable` added is removed, the unit's links must then be the ones found before the apply,
 * and `is-enabled` must read the `UnitFileState` found then.
 */
async function restoreEnablement(
  adapter: SystemdHostAdapter,
  options: ApplySystemdUnitOptions,
  point: SystemdRollbackPoint,
): Promise<void> {
  const { scope, unitName } = options;
  const read = () => readEnablementLinks(adapter, point.linkDirs, point.linkNames);
  if (await restoreEnablementLinks(adapter, unitName, point.linksBefore, await read()))
    await runSystemctlChecked(adapter, scope, ['daemon-reload']);
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

/**
 * Put back the unit file and the state an apply changed. Every step is a checked command, so
 * a step that fails throws and the caller does not answer `rolledBack: true`.
 */
async function restorePreviousUnit(
  adapter: SystemdHostAdapter,
  options: ApplySystemdUnitOptions,
  point: SystemdRollbackPoint,
): Promise<void> {
  const { scope, unitName, unitPath } = options;
  if (point.previousBytes === null) {
    if (point.didRestart) await runSystemctlChecked(adapter, scope, ['stop', '--', unitName]);
    if (point.didEnable) await restoreEnablement(adapter, options, point);
    await adapter.removeFile(unitPath);
    await runSystemctlChecked(adapter, scope, ['daemon-reload']);
    return;
  }
  // The bytes as they were read, not a decoded copy, and the state the unit was in.
  await adapter.writeFileAtomic(unitPath, point.previousBytes, { mode: point.mode });
  await runSystemctlChecked(adapter, scope, ['daemon-reload']);
  if (point.didRestart) {
    await runSystemctlChecked(adapter, scope, [
      point.wasActive ? 'restart' : 'stop',
      '--',
      unitName,
    ]);
  }
  if (point.didEnable) await restoreEnablement(adapter, options, point);
}

async function applySystemdUnit(
  options: ApplySystemdUnitOptions,
  defaultEnable: boolean,
): Promise<SystemdApplyResult> {
  assertValidSystemdUnitName(options.unitName);
  const stabilityMs = options.stabilityMs ?? DEFAULT_STABILITY_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  assertSystemdWaitMs('stabilityMs', stabilityMs, true);
  assertSystemdWaitMs('pollIntervalMs', pollIntervalMs, false);
  assertSystemdWaitMs('startupTimeoutMs', startupTimeoutMs, false);

  const adapter = options.adapter ?? createDefaultSystemdHostAdapter();
  const preCheck = await checkSystemdUnit({
    unitName: options.unitName,
    unitPath: options.unitPath,
    expectedContent: options.content,
    scope: options.scope,
    ...(options.unitSearchDirs ? { unitSearchDirs: options.unitSearchDirs } : {}),
    adapter,
  });
  if (preCheck.foreignDropIns.length > 0) {
    throw new SystemdUnitError(
      'FOREIGN_DROP_IN',
      `Refusing to manage ${options.unitName}: foreign drop-ins present (${preCheck.foreignDropIns.join(', ')})`,
      { rolledBack: false, foreignDropIns: preCheck.foreignDropIns },
    );
  }
  // The manager already answers for this name from somewhere else: writing our file would
  // restart that unit and report the digest of a file systemd never reads.
  const foreign = foreignUnitSource(preCheck, options.unitPath);
  if (foreign !== undefined) {
    throw new SystemdUnitError(
      'FOREIGN_FRAGMENT',
      `Refusing to manage ${options.unitName}: ${foreign}`,
      { rolledBack: false },
    );
  }
  // The stability wait needs a main process that stays; a oneshot unit exits by design.
  if (ONESHOT_TYPE.test(options.content)) {
    throw new SystemdUnitError(
      'UNSUPPORTED_UNIT_TYPE',
      `Refusing to apply ${options.unitName}: Type=oneshot has no main process to hold stable`,
      { rolledBack: false },
    );
  }

  // A link at the path names a file somebody else owns: we write our own file or none.
  const standing = await adapter.inspectPath(options.unitPath);
  if (standing.kind === 'symlink' || standing.kind === 'other') {
    throw new SystemdUnitError(
      'FOREIGN_FRAGMENT',
      `Refusing to manage ${options.unitName}: ${options.unitPath} is ${standing.kind === 'symlink' ? `a symbolic link to ${standing.target}` : 'not a regular file'}, not a unit file of ours to replace`,
      { rolledBack: false },
    );
  }
  const previousBytes = await adapter.readFile(options.unitPath);
  const wasActive = preCheck.activeState === 'active';
  const mode = options.mode ?? DEFAULT_SYSTEMD_UNIT_MODE;
  const enable = options.enable ?? defaultEnable;
  // What a rollback compares against: the enable links of the unit and its `Also=` units now.
  const linkNames = enablementNamesOf(options.unitName, options.unitPath, [
    options.content,
    ...(previousBytes === null ? [] : [new TextDecoder().decode(previousBytes)]),
  ]);
  const linkDirs = enable
    ? await resolveUnitSearchDirs(
        options.unitPath,
        options.scope,
        options.unitSearchDirs,
        adapter,
      )
    : [];
  const linksBefore = enable
    ? await readEnablementLinks(adapter, linkDirs, linkNames)
    : new Map<string, string>();
  await adapter.writeFileAtomic(options.unitPath, options.content, { mode });

  let didEnable = false;
  let didRestart = false;
  try {
    await runSystemctlChecked(adapter, options.scope, ['daemon-reload']);
    // Only now does systemd say which file it loaded for this name. A unit of the same name
    // earlier on its search path shadows the one just written.
    const loaded = await checkSystemdUnit({
      unitName: options.unitName,
      unitPath: options.unitPath,
      expectedContent: options.content,
      scope: options.scope,
      ...(options.unitSearchDirs ? { unitSearchDirs: options.unitSearchDirs } : {}),
      adapter,
    });
    if (loaded.status !== 'matches') {
      throw new SystemdUnitError(
        'FOREIGN_FRAGMENT',
        `systemd did not load ${options.unitPath} for ${options.unitName} (${loaded.status}, LoadState=${loaded.loadState ?? 'unknown'}, FragmentPath=${loaded.fragmentPath ?? 'none'})`,
      );
    }
    if (enable) {
      // Set before the command: an `enable` that answers an error may still have linked.
      didEnable = true;
      await runSystemctlChecked(adapter, options.scope, ['enable', '--', options.unitName]);
    }
    didRestart = true;
    await runSystemctlChecked(adapter, options.scope, ['restart', '--', options.unitName]);
    const settled = await waitForStableSystemdUnit(
      options.unitName,
      options.scope,
      adapter,
      startupTimeoutMs,
      stabilityMs,
      pollIntervalMs,
    );
    return {
      unitName: options.unitName,
      digest: computeSha256Hex(options.content),
      mainPid: settled.mainPid,
      stableForMs: settled.stableForMs,
    };
  } catch (cause) {
    let rolledBack = false;
    let rollbackError: unknown;
    try {
      await restorePreviousUnit(adapter, options, {
        // The file put back keeps the mode it had, not the candidate's.
        mode: standing.kind === 'file' ? standing.mode : mode,
        previousBytes,
        wasActive,
        previousUnitFileState: preCheck.unitFileState,
        linkDirs,
        linkNames,
        linksBefore,
        didEnable,
        didRestart,
      });
      rolledBack = true;
    } catch (rbError) {
      rollbackError = rbError;
    }
    const code = cause instanceof SystemdUnitError ? cause.code : 'COMMAND_FAILED';
    const baseMessage = messageOf(cause);
    const message =
      !rolledBack && rollbackError !== undefined
        ? `${baseMessage}; rollback also failed: ${messageOf(rollbackError)}`
        : baseMessage;
    throw new SystemdUnitError(code, message, { cause, rolledBack, rollbackError });
  }
}

/**
 * Install, enable (by default), start, and stability-verify a systemd unit,
 * automatically rolling back to the prior unit file if activation or stability fails.
 */
export function installAndStartSystemdUnit(
  options: ApplySystemdUnitOptions,
): Promise<SystemdApplyResult> {
  return applySystemdUnit(options, true);
}

/**
 * Atomically update a systemd unit, daemon-reload, restart, and verify stability,
 * automatically rolling back to the previous unit file on failure.
 */
export function reloadSystemdUnit(
  options: ApplySystemdUnitOptions,
): Promise<SystemdApplyResult> {
  return applySystemdUnit(options, false);
}
