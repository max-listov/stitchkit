import { readdir } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { errnoOf } from '../internal/errno';
import { computeSha256Hex } from './artifact-manifest';
import {
  createBaseServiceHostAdapter,
  isAbsoluteNormalPath,
  type ServiceHostPathState,
  sameHostPath,
} from './host-adapter';
import {
  type SystemdScope,
  SystemdScopeSchema,
  SystemdUnitError,
} from './systemd-render-shared';

export const DEFAULT_SYSTEMD_UNIT_MODE = 0o644;
/**
 * `systemctl` by its absolute path, so an ambient `PATH` cannot substitute another. The
 * systemd package installs it there on Debian 13, Ubuntu 26.04 and Fedora; Debian 12 keeps
 * `/bin/systemctl` and requires a merged `/usr`, where `/bin` is `/usr/bin`.
 */
export const SYSTEMCTL_PATH = '/usr/bin/systemctl';
const SHOW_PROPERTIES =
  'LoadState,FragmentPath,DropInPaths,ActiveState,SubState,MainPID,UnitFileState,NeedDaemonReload';
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

/** Result of running a host supervision command such as `systemctl`. */
export interface SystemdCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Injectable host boundary for systemd operations so unit checks, installs,
 * reloads, and rollbacks can be tested deterministically without root or Linux.
 * Every `runCommand` call names `/usr/bin/systemctl` by its absolute path.
 */
export interface SystemdHostAdapter {
  runCommand(
    executable: string,
    args: readonly string[],
    options?: { timeoutMs?: number },
  ): Promise<SystemdCommandResult>;
  readFile(path: string): Promise<Uint8Array | null>;
  writeFileAtomic(
    path: string,
    content: string | Uint8Array,
    options?: { mode?: number },
  ): Promise<void>;
  removeFile(path: string): Promise<void>;
  /** What stands at `path` without following a link (see {@link ServiceHostPathState}). */
  inspectPath(path: string): Promise<ServiceHostPathState>;
  /** `path` with every symbolic link in its directories resolved; the last component as given. */
  canonicalPath(path: string): Promise<string>;
  listDir(path: string): Promise<string[] | null>;
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** Options for {@link checkSystemdUnit}. */
export interface CheckSystemdUnitOptions {
  /** Unit name such as `example.service`. */
  unitName: string;
  /** Expected on-disk unit file path. */
  unitPath: string;
  /** Expected rendered unit file content whose SHA-256 is verified (mutually exclusive with `expectedDigest`). */
  expectedContent?: string;
  /** Expected lowercase 64-hex SHA-256 digest of the on-disk unit file (mutually exclusive with `expectedContent`). */
  expectedDigest?: string;
  /** Systemd manager scope (`'system'` or `'user'`). */
  scope: SystemdScope;
  /** Additional directories to scan for `<unitName>.d/*.conf` drop-ins. */
  unitSearchDirs?: readonly string[];
  /** Custom host adapter; defaults to the real Linux systemd adapter. */
  adapter?: SystemdHostAdapter;
}

/**
 * Classification returned by {@link checkSystemdUnit}:
 * - `matches`: systemd loads this name from `unitPath`, whose bytes have the expected digest;
 * - `missing`: no file at `unitPath` and nothing else answers for the name (`LoadState=not-found`,
 *   or systemd still holds the unit it read from `unitPath` before the file went);
 * - `digest-mismatch`: the file at `unitPath` has other bytes;
 * - `fragment-mismatch`: systemd answers for the name from somewhere other than `unitPath` — a
 *   vendor, transient or generated unit, a mask, a loaded unit with no file — or has not loaded it;
 * - `foreign-drop-in`: a drop-in Stitchkit does not trust changes the unit.
 */
export type SystemdUnitCheckStatus =
  | 'matches'
  | 'missing'
  | 'digest-mismatch'
  | 'fragment-mismatch'
  | 'foreign-drop-in';

/** Structured inspection report produced by {@link checkSystemdUnit}. */
export interface SystemdUnitCheckResult {
  ok: boolean;
  status: SystemdUnitCheckStatus;
  expectedDigest: string;
  actualDigest: string | null;
  loadState: string | null;
  fragmentPath: string | null;
  /** Whether `fragmentPath` names `unitPath`, through any symbolic link in their directories. */
  fragmentIsUnitPath: boolean;
  foreignDropIns: string[];
  activeState: string | null;
  mainPid: number | null;
  /** `UnitFileState` as systemd reports it (`enabled`, `disabled`, `static`, …); `null` when empty. */
  unitFileState: string | null;
  /** Whether systemd reports `NeedDaemonReload=yes` because the unit file changed on disk since last reload. */
  needsReload: boolean;
}

/** Options for {@link systemdUnitActive} and {@link systemdMainPid}. */
export interface SystemdUnitQueryOptions {
  /** Unit name such as `example.service`. */
  unitName: string;
  /** Systemd manager scope (`'system'` or `'user'`). */
  scope: SystemdScope;
  /** Custom host adapter; defaults to the real Linux systemd adapter. */
  adapter?: SystemdHostAdapter;
}

/** Create the default Linux host adapter backed by `runNativeCommand` and atomic file I/O. */
export function createDefaultSystemdHostAdapter(): SystemdHostAdapter {
  return {
    ...createBaseServiceHostAdapter({
      defaultFileMode: DEFAULT_SYSTEMD_UNIT_MODE,
      nullOnNonRegularFile: true,
    }),
    async listDir(path) {
      try {
        return await readdir(path);
      } catch (cause) {
        if (errnoOf(cause) === 'ENOENT') return null;
        throw cause;
      }
    },
  };
}

function hasAsciiControlChar(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** Validate a single systemd unit name (no leading `-`, `.`, slashes, traversal, whitespace, or controls). */
export function assertValidSystemdUnitName(unitName: string): void {
  if (
    unitName.length === 0 ||
    unitName === '.' ||
    unitName.startsWith('-') ||
    unitName.includes('/') ||
    unitName.includes('\\') ||
    unitName.includes('..') ||
    /\s/.test(unitName) ||
    hasAsciiControlChar(unitName)
  ) {
    throw new SystemdUnitError(
      'INVALID_CONFIG',
      `Invalid systemd unit name: ${JSON.stringify(unitName)}`,
    );
  }
}

/**
 * Refuse a unit path that is not absolute and normal (`//`, `/./`, `/../`, a trailing `/`):
 * systemd reports the `FragmentPath` it loaded in one spelling, and ownership compares it.
 */
export function assertSystemdUnitPath(unitPath: string): void {
  if (!isAbsoluteNormalPath(unitPath)) {
    throw new SystemdUnitError(
      'INVALID_CONFIG',
      `Unit path must be an absolute, normal path without NUL bytes: ${JSON.stringify(unitPath)}`,
    );
  }
}

/** Prepend `--user` when running `systemctl` in user scope. */
export function systemdScopeArgs(scope: SystemdScope, args: readonly string[]): string[] {
  const parsed = SystemdScopeSchema.parse(scope);
  return parsed === 'user' ? ['--user', ...args] : [...args];
}

function parseSystemdProperties(stdout: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trimEnd();
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    map.set(line.slice(0, eq), line.slice(eq + 1));
  }
  return map;
}

function parseMainPid(raw: string | undefined): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const pid = Number(trimmed);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function parseUnitPathDirs(stdout: string): string[] {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return [];
  const raw = trimmed.startsWith('UnitPath=') ? trimmed.slice('UnitPath='.length) : trimmed;
  return raw
    .split(/\s+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith('/'));
}

function normalizePosixDir(dir: string): string {
  const normalized = posix.normalize(dir);
  return normalized.length > 1 && normalized.endsWith('/')
    ? normalized.slice(0, -1)
    : normalized;
}

function isAllowedHostServiceDropIn(
  unitName: string,
  dropInPath: string,
  trustedSearchDirs: ReadonlySet<string>,
): boolean {
  if (!unitName.endsWith('.service')) return false;
  if (!dropInPath.startsWith('/')) return false;
  if (dropInPath.includes('..')) return false;
  if (posix.normalize(dropInPath) !== dropInPath) return false;
  if (!dropInPath.endsWith('.conf')) return false;
  const parentDir = posix.dirname(dropInPath);
  if (posix.basename(parentDir) !== 'service.d') return false;
  const grandParentDir = posix.dirname(parentDir);
  return trustedSearchDirs.has(grandParentDir);
}

function templateUnitNameOf(unitName: string): string | null {
  const atIndex = unitName.indexOf('@');
  if (atIndex <= 0) return null;
  const dotIndex = unitName.lastIndexOf('.');
  if (dotIndex <= atIndex + 1) return null;
  return `${unitName.slice(0, atIndex + 1)}${unitName.slice(dotIndex)}`;
}

/** `dirname(unitPath)`, every directory of the manager's `UnitPath`, and `extraSearchDirs`. */
export async function resolveUnitSearchDirs(
  unitPath: string,
  scope: SystemdScope,
  extraSearchDirs: readonly string[] | undefined,
  adapter: SystemdHostAdapter,
): Promise<string[]> {
  // Both spellings of the unit's directory: systemd names what it reads with links resolved.
  const searchDirs = new Set<string>([
    dirname(unitPath),
    dirname(await adapter.canonicalPath(unitPath)),
  ]);
  const unitPathResult = await adapter.runCommand(
    SYSTEMCTL_PATH,
    systemdScopeArgs(scope, ['show', '--no-pager', '--property=UnitPath', '--value']),
  );
  if (unitPathResult.exitCode !== 0) {
    throw new SystemdUnitError(
      'COMMAND_FAILED',
      `systemctl show --property=UnitPath failed (exit ${unitPathResult.exitCode}): ${unitPathResult.stderr.trim()}`,
    );
  }
  const managerDirs = parseUnitPathDirs(unitPathResult.stdout);
  if (managerDirs.length > 0) {
    for (const dir of managerDirs) searchDirs.add(dir);
  } else if (scope === 'system') {
    searchDirs.add('/etc/systemd/system');
    searchDirs.add('/run/systemd/system');
  }
  for (const dir of extraSearchDirs ?? []) searchDirs.add(dir);
  return [...searchDirs];
}

async function collectForeignDropIns(
  unitName: string,
  unitPath: string,
  scope: SystemdScope,
  dropInPathsProp: string | undefined,
  extraSearchDirs: readonly string[] | undefined,
  adapter: SystemdHostAdapter,
): Promise<string[]> {
  const searchDirs = await resolveUnitSearchDirs(unitPath, scope, extraSearchDirs, adapter);
  const trustedSearchDirs = new Set(searchDirs.map(normalizePosixDir));
  const found = new Set<string>();
  if (dropInPathsProp) {
    for (const token of dropInPathsProp.trim().split(/\s+/)) {
      if (token.length === 0) continue;
      if (isAllowedHostServiceDropIn(unitName, token, trustedSearchDirs)) continue;
      found.add(token);
    }
  }

  const templateUnitName = templateUnitNameOf(unitName);
  const dropInDirNames =
    templateUnitName !== null ? [`${unitName}.d`, `${templateUnitName}.d`] : [`${unitName}.d`];

  for (const dir of searchDirs) {
    for (const dropInDirName of dropInDirNames) {
      const dropInDir = join(dir, dropInDirName);
      const entries = await adapter.listDir(dropInDir);
      if (!entries) continue;
      for (const entry of entries) {
        if (entry.endsWith('.conf')) found.add(join(dropInDir, entry));
      }
    }
  }
  return [...found].sort();
}

/**
 * Why systemd answers for this name from somewhere other than `unitPath`, if it does: a mask,
 * a unit file elsewhere (vendor, transient, generator), a loaded unit with no file, or a
 * `systemctl show` that named no load state. A name systemd does not find, or loads from
 * `unitPath`, has none.
 */
export function foreignUnitSource(
  check: {
    loadState: string | null;
    fragmentPath: string | null;
    fragmentIsUnitPath: boolean;
  },
  unitPath: string,
): string | undefined {
  if (check.loadState === 'masked') return 'the unit is masked';
  if (check.loadState === 'not-found' || check.fragmentIsUnitPath) return undefined;
  if (check.loadState === null) return 'systemctl show reported no LoadState';
  if (check.fragmentPath === null) {
    return `systemd has it ${check.loadState} with no unit file`;
  }
  return `systemd loads it from ${check.fragmentPath}, not ${unitPath}`;
}

function resolveExpectedDigest(options: CheckSystemdUnitOptions): string {
  const hasContent = options.expectedContent !== undefined;
  const hasDigest = options.expectedDigest !== undefined;
  if (hasContent === hasDigest) {
    throw new SystemdUnitError(
      'INVALID_CONFIG',
      'checkSystemdUnit requires exactly one of expectedContent or expectedDigest',
    );
  }
  if (options.expectedDigest !== undefined) {
    if (!SHA256_HEX_PATTERN.test(options.expectedDigest)) {
      throw new SystemdUnitError(
        'INVALID_CONFIG',
        `Invalid expectedDigest: expected 64 lowercase hex characters, got ${JSON.stringify(options.expectedDigest)}`,
      );
    }
    return options.expectedDigest;
  }
  return computeSha256Hex(options.expectedContent ?? '');
}

/**
 * Inspect an installed systemd unit: compare on-disk SHA-256 against
 * `expectedContent` or `expectedDigest`, query `systemctl show` for `LoadState`/`FragmentPath`/
 * `DropInPaths`, and scan `<unit>.d/*.conf` (plus template `<prefix>@.<type>.d/*.conf`)
 * drop-in directories across `UnitPath` even when `LoadState=not-found`.
 */
export async function checkSystemdUnit(
  options: CheckSystemdUnitOptions,
): Promise<SystemdUnitCheckResult> {
  assertValidSystemdUnitName(options.unitName);
  assertSystemdUnitPath(options.unitPath);
  const expectedDigest = resolveExpectedDigest(options);
  const adapter = options.adapter ?? createDefaultSystemdHostAdapter();
  const existingBytes = await adapter.readFile(options.unitPath);
  const actualDigest = existingBytes === null ? null : computeSha256Hex(existingBytes);

  const showResult = await adapter.runCommand(
    SYSTEMCTL_PATH,
    systemdScopeArgs(options.scope, [
      'show',
      '--no-pager',
      `--property=${SHOW_PROPERTIES}`,
      '--',
      options.unitName,
    ]),
  );
  if (showResult.exitCode !== 0) {
    throw new SystemdUnitError(
      'COMMAND_FAILED',
      `systemctl show failed for ${options.unitName} (exit ${showResult.exitCode}): ${showResult.stderr.trim()}`,
    );
  }
  const props = parseSystemdProperties(showResult.stdout);
  const loadState = props.get('LoadState') || null;
  const fragmentPath = props.get('FragmentPath') || null;
  // systemd may name the file with the links in its directories resolved: the same place in
  // another spelling is `unitPath`.
  const fragmentIsUnitPath =
    fragmentPath !== null && (await sameHostPath(adapter, fragmentPath, options.unitPath));
  const activeState = props.get('ActiveState') || null;
  const mainPid = parseMainPid(props.get('MainPID'));
  const unitFileState = props.get('UnitFileState') || null;
  const needsReload = props.get('NeedDaemonReload') === 'yes';

  const foreignDropIns = await collectForeignDropIns(
    options.unitName,
    options.unitPath,
    options.scope,
    props.get('DropInPaths'),
    options.unitSearchDirs,
    adapter,
  );

  let status: SystemdUnitCheckResult['status'];
  if (foreignDropIns.length > 0) status = 'foreign-drop-in';
  else if (loadState === 'masked') status = 'fragment-mismatch';
  else if (actualDigest === null) {
    status =
      foreignUnitSource({ loadState, fragmentPath, fragmentIsUnitPath }, options.unitPath) ===
      undefined
        ? 'missing'
        : 'fragment-mismatch';
  } else if (actualDigest !== expectedDigest) status = 'digest-mismatch';
  else if (loadState !== 'loaded' || !fragmentIsUnitPath) {
    status = 'fragment-mismatch';
  } else status = 'matches';

  return {
    ok: status === 'matches',
    status,
    expectedDigest,
    actualDigest,
    loadState,
    fragmentPath,
    fragmentIsUnitPath,
    foreignDropIns,
    activeState,
    mainPid,
    unitFileState,
    needsReload,
  };
}

/** Return `true` when `systemctl is-active` reports the unit is `active`. */
export async function systemdUnitActive(options: SystemdUnitQueryOptions): Promise<boolean> {
  assertValidSystemdUnitName(options.unitName);
  const adapter = options.adapter ?? createDefaultSystemdHostAdapter();
  const result = await adapter.runCommand(
    SYSTEMCTL_PATH,
    systemdScopeArgs(options.scope, ['is-active', '--', options.unitName]),
  );
  return result.exitCode === 0 && result.stdout.trim() === 'active';
}

/** Return the unit's current positive `MainPID`, or `null` if not running. */
export async function systemdMainPid(
  options: SystemdUnitQueryOptions,
): Promise<number | null> {
  assertValidSystemdUnitName(options.unitName);
  const adapter = options.adapter ?? createDefaultSystemdHostAdapter();
  const result = await adapter.runCommand(
    SYSTEMCTL_PATH,
    systemdScopeArgs(options.scope, [
      'show',
      '--no-pager',
      '--property=MainPID',
      '--value',
      '--',
      options.unitName,
    ]),
  );
  if (result.exitCode !== 0) return null;
  return parseMainPid(result.stdout);
}
