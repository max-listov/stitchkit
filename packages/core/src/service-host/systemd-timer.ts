import { messageOf } from '../internal/error-message';
import { computeSha256Hex } from './artifact-manifest';
import {
  assertSystemdUnitPath,
  assertValidSystemdUnitName,
  checkSystemdUnit,
  createDefaultSystemdHostAdapter,
  DEFAULT_SYSTEMD_UNIT_MODE,
  resolveUnitSearchDirs,
  type SystemdHostAdapter,
  type SystemdUnitCheckResult,
  systemdUnitActive,
} from './systemd-inspect';
import { enablementNamesOf, readEnablementLinks } from './systemd-links';
import { type SystemdScope, SystemdUnitError } from './systemd-render-shared';
import { rollbackTimerPair } from './systemd-timer-rollback';
import {
  assertNoForeignUnit,
  assertOwnedRegularPath,
  runSystemctlChecked,
} from './systemd-unit-ops';

/** Options for {@link checkSystemdTimerPair}. */
export interface CheckSystemdTimerPairOptions {
  /** Companion `.service` unit name such as `example.service`. */
  serviceUnitName: string;
  /** Expected on-disk path of the `.service` unit file. */
  serviceUnitPath: string;
  /** Expected `.service` content (mutually exclusive with `expectedServiceDigest`). */
  expectedServiceContent?: string;
  /** Expected 64-hex SHA-256 digest of the `.service` file. */
  expectedServiceDigest?: string;
  /** `.timer` unit name such as `example.timer`. */
  timerUnitName: string;
  /** Expected on-disk path of the `.timer` unit file. */
  timerUnitPath: string;
  /** Expected `.timer` content (mutually exclusive with `expectedTimerDigest`). */
  expectedTimerContent?: string;
  /** Expected 64-hex SHA-256 digest of the `.timer` file. */
  expectedTimerDigest?: string;
  /** Systemd manager scope (`'system'` or `'user'`). */
  scope: SystemdScope;
  /** Additional directories to scan for foreign drop-ins. */
  unitSearchDirs?: readonly string[];
  /** Custom host adapter; defaults to the real Linux systemd adapter. */
  adapter?: SystemdHostAdapter;
}

/** Structured inspection report produced by {@link checkSystemdTimerPair}. */
export interface SystemdTimerPairCheckResult {
  ok: boolean;
  service: SystemdUnitCheckResult;
  timer: SystemdUnitCheckResult;
  timerActive: boolean;
  timerEnabled: boolean;
}

/** Options for {@link installSystemdTimerPair}. */
export interface InstallSystemdTimerPairOptions {
  /** Companion `.service` unit name such as `example.service`. */
  serviceUnitName: string;
  /** Destination path for the `.service` unit file. */
  serviceUnitPath: string;
  /** Rendered `.service` unit content to install. */
  serviceContent: string;
  /** `.timer` unit name such as `example.timer`. */
  timerUnitName: string;
  /** Destination path for the `.timer` unit file. */
  timerUnitPath: string;
  /** Rendered `.timer` unit content to install. */
  timerContent: string;
  /** Systemd manager scope (`'system'` or `'user'`). */
  scope: SystemdScope;
  /** File mode applied atomically to both unit files (default: `0o644`). */
  mode?: number;
  /** Whether to run `systemctl enable` on the `.timer` unit (default: `true`). */
  enable?: boolean;
  /** Whether to start/restart the `.timer` unit without starting the `.service` (default: `true`). */
  start?: boolean;
  /** Additional directories to scan for foreign drop-ins. */
  unitSearchDirs?: readonly string[];
  /** Custom host adapter; defaults to the real Linux systemd adapter. */
  adapter?: SystemdHostAdapter;
}

/** Result returned when {@link installSystemdTimerPair} succeeds. */
export interface SystemdTimerPairInstallResult {
  serviceUnitName: string;
  serviceDigest: string;
  timerUnitName: string;
  timerDigest: string;
  changed: boolean;
  timerActive: boolean;
  timerEnabled: boolean;
}

function assertPairNames(serviceUnitName: string, timerUnitName: string): void {
  assertValidSystemdUnitName(serviceUnitName);
  assertValidSystemdUnitName(timerUnitName);
  if (!serviceUnitName.endsWith('.service')) {
    throw new SystemdUnitError(
      'INVALID_CONFIG',
      `serviceUnitName must end with '.service': ${JSON.stringify(serviceUnitName)}`,
    );
  }
  if (!timerUnitName.endsWith('.timer')) {
    throw new SystemdUnitError(
      'INVALID_CONFIG',
      `timerUnitName must end with '.timer': ${JSON.stringify(timerUnitName)}`,
    );
  }
}

/** Parse `Unit=` strictly inside `[Timer]` and confirm the timer targets `serviceUnitName`. */
function assertTimerTargetsService(
  timerContent: string,
  timerUnitName: string,
  serviceUnitName: string,
): void {
  let inTimer = false;
  const declared: string[] = [];
  for (const rawLine of timerContent.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#') || line.startsWith(';')) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      inTimer = line === '[Timer]';
      continue;
    }
    if (!inTimer) continue;
    const match = /^Unit[ \t]*=(.*)$/.exec(line);
    if (match) declared.push((match[1] ?? '').trim());
  }
  if (declared.length > 1) {
    throw new SystemdUnitError(
      'INVALID_CONFIG',
      `Timer ${timerUnitName} declares multiple Unit= directives in [Timer]`,
    );
  }
  const target =
    declared.length === 1
      ? declared[0]
      : `${timerUnitName.slice(0, -'.timer'.length)}.service`;
  if (!target || target !== serviceUnitName) {
    throw new SystemdUnitError(
      'INVALID_CONFIG',
      `Timer ${timerUnitName} targets ${JSON.stringify(target)}, expected ${JSON.stringify(serviceUnitName)}`,
    );
  }
}

/** Inspect both `.service` and `.timer` units of a timer-driven pair. */
export async function checkSystemdTimerPair(
  options: CheckSystemdTimerPairOptions,
): Promise<SystemdTimerPairCheckResult> {
  assertPairNames(options.serviceUnitName, options.timerUnitName);
  assertSystemdUnitPath(options.serviceUnitPath);
  assertSystemdUnitPath(options.timerUnitPath);
  const adapter = options.adapter ?? createDefaultSystemdHostAdapter();
  const service = await checkSystemdUnit({
    unitName: options.serviceUnitName,
    unitPath: options.serviceUnitPath,
    ...(options.expectedServiceContent !== undefined && {
      expectedContent: options.expectedServiceContent,
    }),
    ...(options.expectedServiceDigest !== undefined && {
      expectedDigest: options.expectedServiceDigest,
    }),
    scope: options.scope,
    ...(options.unitSearchDirs ? { unitSearchDirs: options.unitSearchDirs } : {}),
    adapter,
  });
  const timer = await checkSystemdUnit({
    unitName: options.timerUnitName,
    unitPath: options.timerUnitPath,
    ...(options.expectedTimerContent !== undefined && {
      expectedContent: options.expectedTimerContent,
    }),
    ...(options.expectedTimerDigest !== undefined && {
      expectedDigest: options.expectedTimerDigest,
    }),
    scope: options.scope,
    ...(options.unitSearchDirs ? { unitSearchDirs: options.unitSearchDirs } : {}),
    adapter,
  });
  return {
    ok: service.ok && timer.ok,
    service,
    timer,
    timerActive: timer.activeState === 'active',
    timerEnabled: timer.unitFileState === 'enabled',
  };
}

async function activateTimerAfterReload(
  adapter: SystemdHostAdapter,
  options: InstallSystemdTimerPairOptions,
  pre: SystemdTimerPairCheckResult,
  loaded: SystemdTimerPairCheckResult,
  wroteTimer: boolean,
  enable: boolean,
  start: boolean,
  mark: { onEnable(): void; onActivate(): void },
): Promise<{ timerActive: boolean; timerEnabled: boolean }> {
  if (enable && !loaded.timerEnabled) {
    mark.onEnable();
    await runSystemctlChecked(adapter, options.scope, ['enable', '--', options.timerUnitName]);
  }
  if (start) {
    if (pre.timerActive) {
      if (wroteTimer || pre.timer.needsReload) {
        mark.onActivate();
        await runSystemctlChecked(adapter, options.scope, [
          'restart',
          '--',
          options.timerUnitName,
        ]);
      }
    } else {
      mark.onActivate();
      await runSystemctlChecked(adapter, options.scope, [
        'start',
        '--',
        options.timerUnitName,
      ]);
    }
    const active = await systemdUnitActive({
      unitName: options.timerUnitName,
      scope: options.scope,
      adapter,
    });
    if (!active) {
      throw new SystemdUnitError(
        'START_TIMEOUT',
        `Systemd timer ${options.timerUnitName} is not active after activation`,
      );
    }
  }
  return {
    timerActive: start ? true : loaded.timerActive,
    timerEnabled: enable ? true : loaded.timerEnabled,
  };
}

/**
 * Idempotently install a `.service` + `.timer` pair, daemon-reload, and optionally
 * enable/start (or restart on schedule change) the `.timer` without ever starting the
 * `.service` directly. Rolls back both unit files, enablement links, and timer activation
 * state on any failure.
 */
export async function installSystemdTimerPair(
  options: InstallSystemdTimerPairOptions,
): Promise<SystemdTimerPairInstallResult> {
  assertPairNames(options.serviceUnitName, options.timerUnitName);
  assertSystemdUnitPath(options.serviceUnitPath);
  assertSystemdUnitPath(options.timerUnitPath);
  assertTimerTargetsService(
    options.timerContent,
    options.timerUnitName,
    options.serviceUnitName,
  );

  const adapter = options.adapter ?? createDefaultSystemdHostAdapter();
  const mode = options.mode ?? DEFAULT_SYSTEMD_UNIT_MODE;
  const enable = options.enable ?? true;
  const start = options.start ?? true;
  const serviceDigest = computeSha256Hex(options.serviceContent);
  const timerDigest = computeSha256Hex(options.timerContent);

  const pre = await checkSystemdTimerPair({
    serviceUnitName: options.serviceUnitName,
    serviceUnitPath: options.serviceUnitPath,
    expectedServiceContent: options.serviceContent,
    timerUnitName: options.timerUnitName,
    timerUnitPath: options.timerUnitPath,
    expectedTimerContent: options.timerContent,
    scope: options.scope,
    ...(options.unitSearchDirs ? { unitSearchDirs: options.unitSearchDirs } : {}),
    adapter,
  });
  assertNoForeignUnit(options.serviceUnitName, options.serviceUnitPath, pre.service);
  assertNoForeignUnit(options.timerUnitName, options.timerUnitPath, pre.timer);

  const serviceStanding = await adapter.inspectPath(options.serviceUnitPath);
  const timerStanding = await adapter.inspectPath(options.timerUnitPath);
  assertOwnedRegularPath(options.serviceUnitName, options.serviceUnitPath, serviceStanding);
  assertOwnedRegularPath(options.timerUnitName, options.timerUnitPath, timerStanding);

  const serviceModeMatches = serviceStanding.kind === 'file' && serviceStanding.mode === mode;
  const timerModeMatches = timerStanding.kind === 'file' && timerStanding.mode === mode;
  const serviceBytesMatch = pre.service.actualDigest === serviceDigest;
  const timerBytesMatch = pre.timer.actualDigest === timerDigest;
  const isNoop =
    pre.service.status === 'matches' &&
    pre.timer.status === 'matches' &&
    !pre.service.needsReload &&
    !pre.timer.needsReload &&
    serviceModeMatches &&
    timerModeMatches &&
    (!enable || pre.timerEnabled) &&
    (!start || pre.timerActive);
  if (isNoop) {
    return {
      serviceUnitName: options.serviceUnitName,
      serviceDigest,
      timerUnitName: options.timerUnitName,
      timerDigest,
      changed: false,
      timerActive: pre.timerActive,
      timerEnabled: pre.timerEnabled,
    };
  }

  const previousServiceBytes = await adapter.readFile(options.serviceUnitPath);
  const previousTimerBytes = await adapter.readFile(options.timerUnitPath);
  const linkNames = enablementNamesOf(options.timerUnitName, options.timerUnitPath, [
    options.timerContent,
    ...(previousTimerBytes === null ? [] : [new TextDecoder().decode(previousTimerBytes)]),
  ]);
  const linkDirs = enable
    ? await resolveUnitSearchDirs(
        options.timerUnitPath,
        options.scope,
        options.unitSearchDirs,
        adapter,
      )
    : [];
  const linksBefore = enable
    ? await readEnablementLinks(adapter, linkDirs, linkNames)
    : new Map<string, string>();

  let wroteService = false;
  let wroteTimer = false;
  let didEnable = false;
  let didActivate = false;
  try {
    if (!serviceBytesMatch || !serviceModeMatches) {
      wroteService = true;
      await adapter.writeFileAtomic(options.serviceUnitPath, options.serviceContent, { mode });
    }
    if (!timerBytesMatch || !timerModeMatches) {
      wroteTimer = true;
      await adapter.writeFileAtomic(options.timerUnitPath, options.timerContent, { mode });
    }
    if (
      wroteService ||
      wroteTimer ||
      pre.service.needsReload ||
      pre.timer.needsReload ||
      pre.service.status !== 'matches' ||
      pre.timer.status !== 'matches'
    ) {
      await runSystemctlChecked(adapter, options.scope, ['daemon-reload']);
    }
    const loaded = await checkSystemdTimerPair({
      serviceUnitName: options.serviceUnitName,
      serviceUnitPath: options.serviceUnitPath,
      expectedServiceContent: options.serviceContent,
      timerUnitName: options.timerUnitName,
      timerUnitPath: options.timerUnitPath,
      expectedTimerContent: options.timerContent,
      scope: options.scope,
      ...(options.unitSearchDirs ? { unitSearchDirs: options.unitSearchDirs } : {}),
      adapter,
    });
    if (!loaded.service.ok) {
      throw new SystemdUnitError(
        'FOREIGN_FRAGMENT',
        `systemd did not load ${options.serviceUnitPath} for ${options.serviceUnitName} (${loaded.service.status})`,
      );
    }
    if (!loaded.timer.ok) {
      throw new SystemdUnitError(
        'FOREIGN_FRAGMENT',
        `systemd did not load ${options.timerUnitPath} for ${options.timerUnitName} (${loaded.timer.status})`,
      );
    }
    const finalState = await activateTimerAfterReload(
      adapter,
      options,
      pre,
      loaded,
      wroteTimer,
      enable,
      start,
      {
        onEnable: () => {
          didEnable = true;
        },
        onActivate: () => {
          didActivate = true;
        },
      },
    );
    return {
      serviceUnitName: options.serviceUnitName,
      serviceDigest,
      timerUnitName: options.timerUnitName,
      timerDigest,
      changed: true,
      timerActive: finalState.timerActive,
      timerEnabled: finalState.timerEnabled,
    };
  } catch (cause) {
    let rolledBack = false;
    let rollbackError: unknown;
    try {
      await rollbackTimerPair(adapter, {
        scope: options.scope,
        serviceUnitPath: options.serviceUnitPath,
        timerUnitName: options.timerUnitName,
        timerUnitPath: options.timerUnitPath,
        previousServiceBytes,
        previousServiceMode: serviceStanding.kind === 'file' ? serviceStanding.mode : mode,
        previousTimerBytes,
        previousTimerMode: timerStanding.kind === 'file' ? timerStanding.mode : mode,
        timerWasActive: pre.timerActive,
        previousTimerUnitFileState: pre.timer.unitFileState,
        linkDirs,
        linkNames,
        linksBefore,
        wroteService,
        wroteTimer,
        didEnable,
        didActivate,
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
