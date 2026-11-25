import { messageOf } from '../internal/error-message';
import { computeSha256Hex } from './artifact-manifest';
import { sameHostPath } from './host-adapter';
import {
  assertAbsolutePlistPath,
  createDefaultLaunchdHostAdapter,
  LAUNCHCTL_PATH,
  type LaunchdHostAdapter,
  lintLaunchdPlist,
} from './launchd-plist';
import {
  LaunchdJobError,
  type LaunchdJobInspection,
  parseLaunchctlPrint,
} from './launchd-render';
import { extractPlistLabel } from './plist-xml';

const DEFAULT_PLIST_MODE = 0o644;
const DEFAULT_STABILITY_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const DEFAULT_BOOTOUT_SETTLE_TIMEOUT_MS = 5_000;
const MAX_WAIT_MS = 300_000;
/** `launchctl print` exit status for "Could not find service": the one answer meaning "not loaded". */
const LAUNCHCTL_SERVICE_NOT_FOUND_EXIT = 113;

/** Options for {@link inspectLaunchdJob}. */
export interface InspectLaunchdJobOptions {
  /** LaunchAgent label such as `com.example.daemon`. */
  label: string;
  /** Numeric POSIX UID of the `gui/<uid>` domain. */
  uid: number;
  /** Custom host adapter; defaults to the real macOS `launchctl` adapter. */
  adapter?: LaunchdHostAdapter;
}

/** Options for {@link bootoutLaunchdJob}. */
export interface BootoutLaunchdJobOptions {
  /** LaunchAgent label such as `com.example.daemon`. */
  label: string;
  /** Numeric POSIX UID of the `gui/<uid>` domain. */
  uid: number;
  /** Maximum time to wait for `launchctl print` to confirm unloading (default: 5,000 ms). */
  settleTimeoutMs?: number;
  /** Polling interval while waiting for unloading (default: 250 ms). */
  pollIntervalMs?: number;
  /** Custom host adapter; defaults to the real macOS `launchctl` adapter. */
  adapter?: LaunchdHostAdapter;
}

/** Options for {@link reloadLaunchdJob}. */
export interface ReloadLaunchdJobOptions {
  /** LaunchAgent label such as `com.example.daemon`. */
  label: string;
  /** Numeric POSIX UID of the `gui/<uid>` domain. */
  uid: number;
  /** Destination path for the `.plist` file. */
  plistPath: string;
  /** Rendered `.plist` XML content to install. */
  content: string;
  /** When set, verifies `launchctl print` reports this exact loaded `program`. */
  expectedProgram?: string;
  /** File mode applied atomically to the plist file (default: `0o644`). */
  mode?: number;
  /**
   * Validate `content` with `/usr/bin/plutil -lint -` before writing to disk or
   * calling `launchctl bootout` (default: `'plutil'`; set `'none'` to skip).
   */
  validatePlist?: 'plutil' | 'none';
  /** Duration the new PID must stay loaded unchanged (default: 5,000 ms; 0 skips wait). */
  stabilityMs?: number;
  /** Polling interval during startup and stability checks (default: 250 ms). */
  pollIntervalMs?: number;
  /** Maximum time to wait for a loaded PID after `bootstrap` (default: 10,000 ms). */
  startupTimeoutMs?: number;
  /** Maximum time to wait for `bootout` teardown before calling `bootstrap` (default: 5,000 ms). */
  bootoutSettleTimeoutMs?: number;
  /** Custom host adapter; defaults to the real macOS `launchctl` adapter. */
  adapter?: LaunchdHostAdapter;
}

/** Result returned when {@link reloadLaunchdJob} succeeds. */
export interface LaunchdReloadResult {
  label: string;
  digest: string;
  pid: number;
  program: string | null;
  stableForMs: number;
}

function assertValidLaunchdTarget(
  label: string,
  uid: number,
): { domain: string; service: string } {
  if (
    label.length === 0 ||
    label.includes('/') ||
    label.includes('\\') ||
    label.includes('\0') ||
    /\s/.test(label)
  ) {
    throw new LaunchdJobError(
      'INVALID_CONFIG',
      `Invalid launchd label: ${JSON.stringify(label)}`,
    );
  }
  if (!Number.isSafeInteger(uid) || uid < 0) {
    throw new LaunchdJobError('INVALID_CONFIG', `Invalid launchd uid: ${uid}`);
  }
  const domain = `gui/${uid}`;
  return { domain, service: `${domain}/${label}` };
}

function assertLaunchdWaitMs(name: string, value: number, allowZero: boolean): void {
  const min = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(value) || value < min || value > MAX_WAIT_MS) {
    throw new LaunchdJobError(
      'INVALID_CONFIG',
      `Invalid ${name}: expected integer in [${min}, ${MAX_WAIT_MS}], got ${value}`,
    );
  }
}

/**
 * Inspect a macOS LaunchAgent via `launchctl print gui/<uid>/<label>`, returning
 * `{ loaded: false, ... }` when the service is absent from the domain (exit 113, "Could not
 * find service"). Any other failure of `launchctl print` throws `COMMAND_FAILED`: whether
 * the job is loaded is then unknown, not "no".
 */
export async function inspectLaunchdJob(
  options: InspectLaunchdJobOptions,
): Promise<LaunchdJobInspection> {
  const { service } = assertValidLaunchdTarget(options.label, options.uid);
  const adapter = options.adapter ?? createDefaultLaunchdHostAdapter();
  const result = await adapter.runCommand(LAUNCHCTL_PATH, ['print', service]);
  if (result.exitCode !== 0 && result.exitCode !== LAUNCHCTL_SERVICE_NOT_FOUND_EXIT) {
    throw new LaunchdJobError(
      'COMMAND_FAILED',
      `launchctl print ${service} failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
    );
  }
  if (result.exitCode !== 0) {
    return {
      loaded: false,
      state: null,
      program: null,
      pid: null,
      path: null,
      lastExitCode: null,
    };
  }
  return parseLaunchctlPrint(result.stdout);
}

async function bootoutAndSettle(
  label: string,
  uid: number,
  service: string,
  settleTimeoutMs: number,
  pollIntervalMs: number,
  adapter: LaunchdHostAdapter,
): Promise<void> {
  // Always bootout before bootstrap (never kickstart -k, which ignores plist edits).
  // A non-zero exit when the job was not loaded yet is normal; we verify unloading via print.
  await adapter.runCommand(LAUNCHCTL_PATH, ['bootout', service]);
  const deadline = adapter.now() + settleTimeoutMs;
  for (;;) {
    const inspected = await inspectLaunchdJob({ label, uid, adapter });
    if (!inspected.loaded) return;
    if (adapter.now() >= deadline) {
      throw new LaunchdJobError(
        'COMMAND_FAILED',
        `launchctl bootout did not unload ${service} within ${settleTimeoutMs}ms`,
      );
    }
    await adapter.sleep(Math.min(pollIntervalMs, Math.max(1, deadline - adapter.now())));
  }
}

/**
 * Unload a macOS LaunchAgent via `launchctl bootout gui/<uid>/<label>` and poll
 * `launchctl print` until the service is confirmed absent from the domain.
 */
export async function bootoutLaunchdJob(options: BootoutLaunchdJobOptions): Promise<void> {
  const { service } = assertValidLaunchdTarget(options.label, options.uid);
  const settleTimeoutMs = options.settleTimeoutMs ?? DEFAULT_BOOTOUT_SETTLE_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  assertLaunchdWaitMs('settleTimeoutMs', settleTimeoutMs, false);
  assertLaunchdWaitMs('pollIntervalMs', pollIntervalMs, false);
  const adapter = options.adapter ?? createDefaultLaunchdHostAdapter();
  await bootoutAndSettle(
    options.label,
    options.uid,
    service,
    settleTimeoutMs,
    pollIntervalMs,
    adapter,
  );
}

async function waitForStableLaunchdJob(
  label: string,
  uid: number,
  expectedProgram: string | undefined,
  startupTimeoutMs: number,
  stabilityMs: number,
  pollIntervalMs: number,
  adapter: LaunchdHostAdapter,
): Promise<{ pid: number; program: string | null; stableForMs: number }> {
  const startDeadline = adapter.now() + startupTimeoutMs;
  let candidatePid: number | null = null;
  let observedProgram: string | null = null;

  for (;;) {
    const inspected = await inspectLaunchdJob({ label, uid, adapter });
    if (inspected.loaded && expectedProgram !== undefined && inspected.program !== null) {
      if (inspected.program !== expectedProgram) {
        throw new LaunchdJobError(
          'PROGRAM_MISMATCH',
          `Loaded launchd program mismatch for ${label}: expected ${expectedProgram}, observed ${inspected.program}`,
        );
      }
    }
    if (inspected.loaded && inspected.pid !== null) {
      if (expectedProgram !== undefined && inspected.program !== expectedProgram) {
        throw new LaunchdJobError(
          'PROGRAM_MISMATCH',
          `Loaded launchd program missing or mismatched for ${label}: expected ${expectedProgram}, observed ${inspected.program ?? 'none'}`,
        );
      }
      candidatePid = inspected.pid;
      observedProgram = inspected.program;
      break;
    }
    if (adapter.now() >= startDeadline) {
      throw new LaunchdJobError(
        'START_TIMEOUT',
        `Launchd job ${label} did not start with a live PID within ${startupTimeoutMs}ms`,
      );
    }
    await adapter.sleep(Math.min(pollIntervalMs, Math.max(1, startDeadline - adapter.now())));
  }

  const stableSince = adapter.now();
  const stableDeadline = stableSince + stabilityMs;
  while (adapter.now() < stableDeadline) {
    await adapter.sleep(Math.min(pollIntervalMs, Math.max(1, stableDeadline - adapter.now())));
    const inspected = await inspectLaunchdJob({ label, uid, adapter });
    if (
      !inspected.loaded ||
      inspected.pid !== candidatePid ||
      (expectedProgram !== undefined && inspected.program !== expectedProgram)
    ) {
      throw new LaunchdJobError(
        'UNSTABLE_CANDIDATE',
        `Launchd job ${label} lost stability during ${stabilityMs}ms window (expected PID ${candidatePid}, observed ${inspected.pid ?? 'none'})`,
      );
    }
  }

  return {
    pid: candidatePid,
    program: observedProgram,
    stableForMs: adapter.now() - stableSince,
  };
}

/**
 * Validate (`plutil -lint` by default), atomically write a LaunchAgent `.plist`,
 * reload it using `launchctl bootout` followed by `launchctl bootstrap` (never
 * `kickstart -k`), verify the loaded `program` and `pid` hold across
 * `stabilityMs`, and automatically roll back to the previous `.plist` on failure.
 */
export async function reloadLaunchdJob(
  options: ReloadLaunchdJobOptions,
): Promise<LaunchdReloadResult> {
  const { domain, service } = assertValidLaunchdTarget(options.label, options.uid);
  assertAbsolutePlistPath(options.plistPath);
  const stabilityMs = options.stabilityMs ?? DEFAULT_STABILITY_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const bootoutSettleTimeoutMs =
    options.bootoutSettleTimeoutMs ?? DEFAULT_BOOTOUT_SETTLE_TIMEOUT_MS;
  const validatePlist = options.validatePlist ?? 'plutil';

  assertLaunchdWaitMs('stabilityMs', stabilityMs, true);
  assertLaunchdWaitMs('pollIntervalMs', pollIntervalMs, false);
  assertLaunchdWaitMs('startupTimeoutMs', startupTimeoutMs, false);
  assertLaunchdWaitMs('bootoutSettleTimeoutMs', bootoutSettleTimeoutMs, false);
  if (validatePlist !== 'plutil' && validatePlist !== 'none') {
    throw new LaunchdJobError(
      'INVALID_CONFIG',
      `Invalid validatePlist mode: ${String(validatePlist)}`,
    );
  }

  const adapter = options.adapter ?? createDefaultLaunchdHostAdapter();

  if (validatePlist === 'plutil') {
    await lintLaunchdPlist({ content: options.content, adapter });
  }

  // launchd loads the job the file names. A file naming another label would leave a job
  // running that neither the wait nor the rollback below ever looks at.
  const declared = extractPlistLabel(options.content);
  if (declared !== options.label) {
    throw new LaunchdJobError(
      'INVALID_PLIST',
      declared === undefined
        ? `Plist for ${options.label} declares no Label`
        : `Plist declares Label ${declared}, but the job being reloaded is ${options.label}`,
    );
  }

  const before = await inspectLaunchdJob({ label: options.label, uid: options.uid, adapter });
  // A job of this label loaded from another plist is not ours: bootout would stop it, and
  // nothing below could load it again.
  // launchd names the plist with the links in its directories resolved (`/private/tmp` for a
  // `plistPath` under `/tmp`): the same place in another spelling is ours.
  if (
    before.loaded &&
    (before.path === null || !(await sameHostPath(adapter, before.path, options.plistPath)))
  ) {
    throw new LaunchdJobError(
      'FOREIGN_FRAGMENT',
      `Refusing to reload ${service}: launchd loaded it from ${before.path ?? 'no plist'}, not ${options.plistPath}`,
      { rolledBack: false },
    );
  }
  // A link at the path names a file somebody else owns (dotfiles): we write our own file or none.
  const standing = await adapter.inspectPath(options.plistPath);
  if (standing.kind === 'symlink' || standing.kind === 'other') {
    throw new LaunchdJobError(
      'FOREIGN_FRAGMENT',
      `Refusing to reload ${service}: ${options.plistPath} is ${standing.kind === 'symlink' ? `a symbolic link to ${standing.target}` : 'not a regular file'}, not a plist of ours to replace`,
      { rolledBack: false },
    );
  }
  const wasLoaded = before.loaded;
  const previousBytes = await adapter.readFile(options.plistPath);
  const mode = options.mode ?? DEFAULT_PLIST_MODE;
  // The file put back keeps the mode it had, not the candidate's.
  const previousMode = standing.kind === 'file' ? standing.mode : mode;

  await adapter.writeFileAtomic(options.plistPath, options.content, { mode });

  let bootstrapped = false;
  try {
    await bootoutAndSettle(
      options.label,
      options.uid,
      service,
      bootoutSettleTimeoutMs,
      pollIntervalMs,
      adapter,
    );
    // Set before the command: a `bootstrap` that answers an error may still have loaded the job.
    bootstrapped = true;
    const result = await adapter.runCommand(LAUNCHCTL_PATH, [
      'bootstrap',
      domain,
      options.plistPath,
    ]);
    if (result.exitCode !== 0) {
      throw new LaunchdJobError(
        'COMMAND_FAILED',
        `launchctl bootstrap ${domain} ${options.plistPath} failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
      );
    }

    const settled = await waitForStableLaunchdJob(
      options.label,
      options.uid,
      options.expectedProgram,
      startupTimeoutMs,
      stabilityMs,
      pollIntervalMs,
      adapter,
    );

    return {
      label: options.label,
      digest: computeSha256Hex(options.content),
      pid: settled.pid,
      program: settled.program,
      stableForMs: settled.stableForMs,
    };
  } catch (cause) {
    let rolledBack = false;
    let rollbackError: unknown;
    try {
      if (bootstrapped) {
        await bootoutAndSettle(
          options.label,
          options.uid,
          service,
          bootoutSettleTimeoutMs,
          pollIntervalMs,
          adapter,
        );
      }
      if (previousBytes !== null) {
        // The bytes as they were read: a binary plist does not survive a text decode.
        await adapter.writeFileAtomic(options.plistPath, previousBytes, {
          mode: previousMode,
        });
        const inspected = await inspectLaunchdJob({
          label: options.label,
          uid: options.uid,
          adapter,
        });
        // A job that was not loaded before the reload is left as it was found.
        if (wasLoaded && !inspected.loaded) {
          const restored = await adapter.runCommand(LAUNCHCTL_PATH, [
            'bootstrap',
            domain,
            options.plistPath,
          ]);
          if (restored.exitCode !== 0) {
            throw new Error(
              `Rollback launchctl bootstrap failed (exit ${restored.exitCode}): ${restored.stderr.trim()}`,
            );
          }
        }
      } else {
        await adapter.removeFile(options.plistPath);
        if (wasLoaded) {
          throw new Error(
            `${service} was loaded from ${options.plistPath}, which had no file: there is nothing to load it again from`,
          );
        }
      }
      // Loaded or not, the job must be as it was found, whichever way a step went wrong.
      const after = await inspectLaunchdJob({
        label: options.label,
        uid: options.uid,
        adapter,
      });
      if (after.loaded !== wasLoaded) {
        throw new Error(
          `${service} is ${after.loaded ? 'loaded' : 'not loaded'} after rollback; it was ${wasLoaded ? 'loaded' : 'not loaded'}`,
        );
      }
      rolledBack = true;
    } catch (rbError) {
      rollbackError = rbError;
    }
    const code = cause instanceof LaunchdJobError ? cause.code : 'COMMAND_FAILED';
    const baseMessage = messageOf(cause);
    const message =
      !rolledBack && rollbackError !== undefined
        ? `${baseMessage}; rollback also failed: ${messageOf(rollbackError)}`
        : baseMessage;
    throw new LaunchdJobError(code, message, { cause, rolledBack, rollbackError });
  }
}
