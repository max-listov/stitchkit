import { lstat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { posix } from 'node:path';
import { errnoOf } from '../../internal/errno';
import { NativeCommandError } from '../../process/contract';
import {
  canonicalizeMacosPath,
  createDefaultMacosCommandRunner,
  isMacosForbiddenBuildRoot,
  isPathWithinDirectory,
  isProtectedMacosSystemPath,
  type MacosCommandRunner,
  macosPathKey,
} from './runner';

/** Absolute path to the macOS CoreServices LaunchServices CLI (`lsregister`). */
export const LSREGISTER_PATH =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

/** macOS `kLSApplicationNotFoundErr` returned by `lsregister -u` when not registered. */
export const KLS_APPLICATION_NOT_FOUND_ERR = -10814;

/** Default safety ceiling on streaming `lsregister -dump` output (128 MiB). */
export const DEFAULT_LSREGISTER_DUMP_MAX_BYTES = 128 * 1024 * 1024;

/** Default safety ceiling on the number of LaunchServices records removed in one pass. */
export const DEFAULT_MAX_UNREGISTRATIONS = 64;

const MAX_DUMP_LINE_CHARS = 65_536;
const NOT_FOUND_ERR_PATTERN = /(?:^|[^\d-])(-10814)(?!\d)|kLSApplicationNotFoundErr/;
const TRAILING_HEX_ID_PATTERN = /\s+\(0x[0-9a-fA-F]+\)\s*$/;
const SECTION_DIVIDER_PATTERN = /^-{10,}$/;

/** Failure classifications thrown by {@link MacosLaunchServicesError}. */
export type MacosLaunchServicesErrorCode =
  | 'INVALID_OPTIONS'
  | 'COMMAND_FAILED'
  | 'LIMIT_EXCEEDED';

/** Structured error thrown by macOS LaunchServices (`lsregister`) helpers. */
export class MacosLaunchServicesError extends Error {
  constructor(
    readonly code: MacosLaunchServicesErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'MacosLaunchServicesError';
  }
}

/** One bundle registration record parsed from `lsregister -dump`. */
export interface LsregisterBundleRecord {
  path: string;
  bundleIdentifier: string | null;
}
/** Result of unregistering a single bundle via {@link forgetRegistration}. */
export type ForgetRegistrationResult = 'unregistered' | 'not-registered';
/** Summary returned by {@link forgetStaleRegistrations} and {@link forgetBuildTree}. */
export interface ForgetStaleRegistrationsResult {
  scanned: number;
  unregistered: string[];
  skippedProtected: string[];
  alreadyAbsent: string[];
}
/** Options for {@link registerBundle} and {@link forgetRegistration}. */
export interface LaunchServicesBundleOptions {
  bundlePath: string;
  timeoutMs?: number;
  runner?: MacosCommandRunner;
}
/** Options for {@link scanLsregisterDump}. */
export interface ScanLsregisterDumpOptions {
  onRecord: (record: LsregisterBundleRecord) => void | Promise<void>;
  maxDumpBytes?: number;
  timeoutMs?: number;
  runner?: MacosCommandRunner;
}
/** Shared filter and limit options for LaunchServices cleanup helpers. */
export interface LaunchServicesSweepOptions {
  bundleId?: string;
  bundleIdPrefix?: string;
  maxUnregistrations?: number;
  maxDumpBytes?: number;
  timeoutMs?: number;
  realpathFn?: (path: string) => Promise<string>;
  runner?: MacosCommandRunner;
}
/** Options for {@link forgetStaleRegistrations}. */
export interface ForgetStaleRegistrationsOptions extends LaunchServicesSweepOptions {
  keepPaths?: readonly string[];
  /** When `true`, also unregister existing bundles outside `keepPaths` (default: `false`). */
  removeExistingOutsideKeep?: boolean;
  pathExists?: (path: string) => Promise<boolean>;
}
/** Options for {@link forgetBuildTree}. */
export interface ForgetBuildTreeOptions extends LaunchServicesSweepOptions {
  buildDir: string;
}

function failOptions(message: string): never {
  throw new MacosLaunchServicesError('INVALID_OPTIONS', message);
}

function assertAbsolutePath(label: string, targetPath: string): void {
  if (!targetPath.startsWith('/') || targetPath.includes('\0') || targetPath.length === 0) {
    failOptions(
      `${label} must be an absolute path without NUL bytes: ${JSON.stringify(targetPath)}`,
    );
  }
}

function assertPositiveLimit(
  label: string,
  value: number | undefined,
  fallback: number,
): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit <= 0) failOptions(`Invalid ${label}: ${limit}`);
  return limit;
}

/** Register an installed `.app` bundle with macOS LaunchServices (`lsregister -f`). */
export async function registerBundle(options: LaunchServicesBundleOptions): Promise<void> {
  assertAbsolutePath('bundlePath', options.bundlePath);
  const runner = options.runner ?? createDefaultMacosCommandRunner();
  const result = await runner.runCommand(LSREGISTER_PATH, ['-f', options.bundlePath], {
    timeoutMs: options.timeoutMs,
  });
  if (result.exitCode !== 0) {
    throw new MacosLaunchServicesError(
      'COMMAND_FAILED',
      `lsregister -f failed for ${options.bundlePath} (exit ${result.exitCode}): ${(result.stderr || result.stdout).trim()}`,
    );
  }
}

/**
 * Unregister a single bundle via `lsregister -u`. Returns `'not-registered'`
 * ONLY on `kLSApplicationNotFoundErr` (`-10814`); other errors throw.
 */
export async function forgetRegistration(
  options: LaunchServicesBundleOptions,
): Promise<ForgetRegistrationResult> {
  assertAbsolutePath('bundlePath', options.bundlePath);
  const runner = options.runner ?? createDefaultMacosCommandRunner();
  const result = await runner.runCommand(LSREGISTER_PATH, ['-u', options.bundlePath], {
    timeoutMs: options.timeoutMs,
  });
  if (result.exitCode === 0) return 'unregistered';
  const combined = `${result.stderr}\n${result.stdout}`;
  // Strip bundlePath before matching -10814 so paths containing "-10814" never fake not-registered.
  const sanitized = combined.replaceAll(options.bundlePath, '');
  if (NOT_FOUND_ERR_PATTERN.test(sanitized)) return 'not-registered';
  throw new MacosLaunchServicesError(
    'COMMAND_FAILED',
    `lsregister -u failed for ${options.bundlePath} (exit ${result.exitCode}): ${combined.trim()}`,
  );
}

function stripHexId(raw: string): string {
  return raw.trim().replace(TRAILING_HEX_ID_PATTERN, '').trim();
}

/** Create an O(1)-memory incremental line parser for `lsregister -dump` output. */
export function createLsregisterDumpParser(
  onRecord: (record: LsregisterBundleRecord) => void,
): {
  push(text: string): void;
  flush(): void;
} {
  let pending = '';
  let discardingLongLine = false;
  let currentPath: string | null = null;
  let currentBundleId: string | null = null;

  const emitSection = (): void => {
    if (currentPath !== null)
      onRecord({ path: currentPath, bundleIdentifier: currentBundleId });
    currentPath = null;
    currentBundleId = null;
  };
  const processLine = (rawLine: string): void => {
    const trimmed = rawLine.trim();
    if (SECTION_DIVIDER_PATTERN.test(trimmed)) {
      emitSection();
      return;
    }
    if (trimmed.startsWith('path:')) {
      if (currentPath === null) {
        const value = stripHexId(trimmed.slice(5));
        if (value.startsWith('/') && !value.includes('\0')) currentPath = value;
      }
    } else if (trimmed.startsWith('identifier:')) {
      if (currentBundleId === null) {
        const value = stripHexId(trimmed.slice(11));
        if (value.length > 0 && value !== '(null)') currentBundleId = value;
      }
    }
  };

  return {
    push(text) {
      let start = 0;
      if (discardingLongLine) {
        const nl = text.indexOf('\n');
        if (nl < 0) return;
        discardingLongLine = false;
        start = nl + 1;
      }
      const chunk = start > 0 ? text.slice(start) : text;
      const combined = pending.length > 0 ? pending + chunk : chunk;
      let cursor = 0;
      for (
        let nl = combined.indexOf('\n', cursor);
        nl >= 0;
        nl = combined.indexOf('\n', cursor)
      ) {
        if (nl - cursor <= MAX_DUMP_LINE_CHARS) {
          processLine(combined.slice(cursor, nl));
        }
        cursor = nl + 1;
      }
      const remainderLen = combined.length - cursor;
      if (remainderLen > MAX_DUMP_LINE_CHARS) {
        pending = '';
        discardingLongLine = true;
      } else {
        pending = cursor > 0 ? combined.slice(cursor) : combined;
      }
    },
    flush() {
      if (!discardingLongLine && pending.length > 0) {
        processLine(pending);
      }
      pending = '';
      discardingLongLine = false;
      emitSection();
    },
  };
}

/** Parse a complete `lsregister -dump` string into bundle records. */
export function parseLsregisterDump(dumpText: string): LsregisterBundleRecord[] {
  const records: LsregisterBundleRecord[] = [];
  const parser = createLsregisterDumpParser((record) => records.push(record));
  parser.push(dumpText);
  parser.flush();
  return records;
}

/** Stream `lsregister -dump` with O(1) memory through `onOutput`, enforcing `maxDumpBytes`. */
export async function scanLsregisterDump(
  options: ScanLsregisterDumpOptions,
): Promise<{ totalBytes: number; recordCount: number }> {
  const maxDumpBytes = assertPositiveLimit(
    'maxDumpBytes',
    options.maxDumpBytes,
    DEFAULT_LSREGISTER_DUMP_MAX_BYTES,
  );
  const runner = options.runner ?? createDefaultMacosCommandRunner();
  const decoder = new TextDecoder('utf-8');
  let totalBytes = 0;
  let recordCount = 0;
  let receivedStreamChunk = false;
  const queuedRecords: LsregisterBundleRecord[] = [];
  const parser = createLsregisterDumpParser((record) => {
    recordCount += 1;
    queuedRecords.push(record);
  });
  const drainQueued = async (): Promise<void> => {
    while (queuedRecords.length > 0) {
      const next = queuedRecords.shift();
      if (next !== undefined) await options.onRecord(next);
    }
  };
  const addBytes = (count: number): void => {
    totalBytes += count;
    if (totalBytes > maxDumpBytes) {
      throw new MacosLaunchServicesError(
        'LIMIT_EXCEEDED',
        `lsregister -dump exceeded maxDumpBytes (${maxDumpBytes})`,
      );
    }
  };

  let result: { exitCode: number; stdout: string; stderr: string };
  try {
    result = await runner.runCommand(LSREGISTER_PATH, ['-dump'], {
      maxOutputBytes: maxDumpBytes,
      timeoutMs: options.timeoutMs,
      async onOutput(chunk, channel) {
        if (channel !== 'stdout') return;
        receivedStreamChunk = true;
        addBytes(chunk.byteLength);
        parser.push(decoder.decode(chunk, { stream: true }));
        await drainQueued();
      },
    });
  } catch (cause) {
    if (cause instanceof NativeCommandError && cause.code === 'COMMAND_LIMIT') {
      throw new MacosLaunchServicesError(
        'LIMIT_EXCEEDED',
        `lsregister -dump exceeded runner limit (${maxDumpBytes} bytes)`,
        { cause },
      );
    }
    throw cause;
  }
  if (result.exitCode !== 0) {
    throw new MacosLaunchServicesError(
      'COMMAND_FAILED',
      `lsregister -dump failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
    );
  }
  if (!receivedStreamChunk && result.stdout.length > 0) {
    addBytes(new TextEncoder().encode(result.stdout).byteLength);
    parser.push(result.stdout);
  } else {
    const trailing = decoder.decode();
    if (trailing.length > 0) parser.push(trailing);
  }
  parser.flush();
  await drainQueued();
  return { totalBytes, recordCount };
}

function matchesBundleFilter(
  record: LsregisterBundleRecord,
  bundleId: string | undefined,
  bundleIdPrefix: string | undefined,
): boolean {
  if (bundleId === undefined && bundleIdPrefix === undefined) return true;
  if (record.bundleIdentifier === null) return false;
  return (
    (bundleId !== undefined && record.bundleIdentifier === bundleId) ||
    (bundleIdPrefix !== undefined && record.bundleIdentifier.startsWith(bundleIdPrefix))
  );
}

async function defaultPathExists(targetPath: string): Promise<boolean> {
  try {
    await lstat(targetPath);
    return true;
  } catch (cause) {
    const code = errnoOf(cause);
    // Fail-closed on EACCES/EPERM: only ENOENT or ENOTDIR proves absence.
    return code !== 'ENOENT' && code !== 'ENOTDIR';
  }
}

async function sweepRegistrations(
  config: LaunchServicesSweepOptions,
  select: (record: LsregisterBundleRecord) => Promise<'skip' | 'protected' | 'unregister'>,
): Promise<ForgetStaleRegistrationsResult> {
  const maxUnregistrations = assertPositiveLimit(
    'maxUnregistrations',
    config.maxUnregistrations,
    DEFAULT_MAX_UNREGISTRATIONS,
  );
  const candidates = new Set<string>();
  const skippedProtected = new Set<string>();
  let scanned = 0;

  await scanLsregisterDump({
    runner: config.runner,
    maxDumpBytes: config.maxDumpBytes,
    timeoutMs: config.timeoutMs,
    async onRecord(record) {
      scanned += 1;
      if (!matchesBundleFilter(record, config.bundleId, config.bundleIdPrefix)) return;
      const decision = await select(record);
      if (decision === 'protected') skippedProtected.add(record.path);
      else if (decision === 'unregister') candidates.add(record.path);
    },
  });

  if (candidates.size > maxUnregistrations) {
    throw new MacosLaunchServicesError(
      'LIMIT_EXCEEDED',
      `Refusing to unregister ${candidates.size} LaunchServices entries (maxUnregistrations=${maxUnregistrations})`,
    );
  }
  const unregistered: string[] = [];
  const alreadyAbsent: string[] = [];
  for (const candidate of candidates) {
    const outcome = await forgetRegistration({
      bundlePath: candidate,
      runner: config.runner,
      timeoutMs: config.timeoutMs,
    });
    if (outcome === 'unregistered') unregistered.push(candidate);
    else alreadyAbsent.push(candidate);
  }
  return { scanned, unregistered, skippedProtected: [...skippedProtected], alreadyAbsent };
}

/** Unregister stale LaunchServices entries matching `bundleId` or `bundleIdPrefix` (fail-closed). */
export async function forgetStaleRegistrations(
  options: ForgetStaleRegistrationsOptions,
): Promise<ForgetStaleRegistrationsResult> {
  const bundleId = options.bundleId?.trim();
  const bundleIdPrefix = options.bundleIdPrefix?.trim();
  if (
    (!bundleId || bundleId.length === 0) &&
    (!bundleIdPrefix || bundleIdPrefix.length === 0)
  ) {
    failOptions('forgetStaleRegistrations requires a non-empty bundleId or bundleIdPrefix');
  }
  if (bundleId?.includes('*') || bundleIdPrefix?.includes('*')) {
    failOptions('Wildcards are not permitted in bundleId or bundleIdPrefix');
  }
  const realpathFn = options.realpathFn ?? realpath;
  const pathExists = options.pathExists ?? defaultPathExists;
  const keepCanonical = new Set<string>();
  for (const keep of options.keepPaths ?? []) {
    assertAbsolutePath('keepPaths[]', keep);
    keepCanonical.add(macosPathKey(await canonicalizeMacosPath(keep, realpathFn)));
  }

  return sweepRegistrations({ ...options, bundleId, bundleIdPrefix }, async (record) => {
    const canonicalRecord = await canonicalizeMacosPath(record.path, realpathFn);
    if (
      isProtectedMacosSystemPath(record.path) ||
      isProtectedMacosSystemPath(canonicalRecord)
    ) {
      return 'protected';
    }
    if (keepCanonical.has(macosPathKey(canonicalRecord))) return 'skip';
    if ((await pathExists(record.path)) && !options.removeExistingOutsideKeep) return 'skip';
    return 'unregister';
  });
}

async function resolveForbiddenHomes(
  realpathFn: (path: string) => Promise<string>,
): Promise<Set<string>> {
  const homes = new Set<string>();
  for (const raw of [homedir(), process.env.HOME]) {
    if (typeof raw === 'string' && raw.startsWith('/') && raw.length > 1) {
      homes.add(macosPathKey(raw));
      homes.add(macosPathKey(await canonicalizeMacosPath(raw, realpathFn)));
    }
  }
  return homes;
}

/** Unregister LaunchServices records strictly inside `buildDir`, refusing `/`, `$HOME`, and system roots. */
export async function forgetBuildTree(
  options: ForgetBuildTreeOptions,
): Promise<ForgetStaleRegistrationsResult> {
  assertAbsolutePath('buildDir', options.buildDir);
  if (options.buildDir.split('/').includes('..')) {
    failOptions(`buildDir must not contain '..' segments: ${options.buildDir}`);
  }
  const rawNormalized = posix.normalize(options.buildDir).replace(/\/+$/, '') || '/';
  const realpathFn = options.realpathFn ?? realpath;
  const canonicalBuildDir = await canonicalizeMacosPath(rawNormalized, realpathFn);
  const forbiddenHomes = await resolveForbiddenHomes(realpathFn);

  if (
    isMacosForbiddenBuildRoot(rawNormalized) ||
    isMacosForbiddenBuildRoot(canonicalBuildDir) ||
    forbiddenHomes.has(macosPathKey(rawNormalized)) ||
    forbiddenHomes.has(macosPathKey(canonicalBuildDir))
  ) {
    failOptions(
      `Refusing to sweep LaunchServices entries for root, home, or system directory: ${options.buildDir}`,
    );
  }

  return sweepRegistrations(options, async (record) => {
    const canonicalRecord = await canonicalizeMacosPath(record.path, realpathFn);
    if (!isPathWithinDirectory(canonicalRecord, canonicalBuildDir)) return 'skip';
    if (
      isProtectedMacosSystemPath(record.path) ||
      isProtectedMacosSystemPath(canonicalRecord)
    ) {
      return 'protected';
    }
    return 'unregister';
  });
}
