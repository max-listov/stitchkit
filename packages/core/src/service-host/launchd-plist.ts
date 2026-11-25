import { z } from 'zod';
import {
  createBaseServiceHostAdapter,
  isAbsoluteNormalPath,
  type ServiceHostPathState,
} from './host-adapter';
import { LaunchdJobError } from './launchd-render';

/** Absolute path to the macOS property list utility (`plutil`). */
export const PLUTIL_PATH = '/usr/bin/plutil';
/** `launchctl` by its fixed macOS path, so an ambient `PATH` cannot substitute another. */
export const LAUNCHCTL_PATH = '/bin/launchctl';

const DEFAULT_PLIST_MODE = 0o644;

const PlistRecordSchema = z.record(z.string(), z.unknown());

/** Result of running a host command such as `launchctl` or `plutil`. */
export interface LaunchdCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Injectable host boundary for macOS `launchd` and `plutil` operations so job
 * inspection, plist validation, `bootout` + `bootstrap` reloads, and rollbacks
 * can be tested deterministically on any OS.
 */
export interface LaunchdHostAdapter {
  runCommand(
    executable: string,
    args: readonly string[],
    options?: { timeoutMs?: number; stdin?: Uint8Array },
  ): Promise<LaunchdCommandResult>;
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
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** Options for {@link lintLaunchdPlist}. */
export interface LintLaunchdPlistOptions {
  /** Raw XML `.plist` content validated on stdin via `/usr/bin/plutil -lint -`. */
  content?: string;
  /** Absolute path to an existing `.plist` file validated via `/usr/bin/plutil -lint <path>`. */
  path?: string;
  /** Command timeout in milliseconds (default: 30,000 ms). */
  timeoutMs?: number;
  /** Custom host adapter; defaults to the real macOS host adapter. */
  adapter?: LaunchdHostAdapter;
}

/** Options for {@link readLaunchdPlist}. */
export interface ReadLaunchdPlistOptions {
  /** Absolute path to the `.plist` file to read via `/usr/bin/plutil -convert json -o - <path>`. */
  path: string;
  /** Command timeout in milliseconds (default: 30,000 ms). */
  timeoutMs?: number;
  /** Custom host adapter; defaults to the real macOS host adapter. */
  adapter?: LaunchdHostAdapter;
}

/** Create the default macOS host adapter backed by `runNativeCommand` and atomic file I/O. */
export function createDefaultLaunchdHostAdapter(): LaunchdHostAdapter {
  return createBaseServiceHostAdapter({
    defaultFileMode: DEFAULT_PLIST_MODE,
    nullOnNonRegularFile: false,
  });
}

/**
 * Refuse a plist path that is not absolute and normal (`//`, `/./`, `/../`, a trailing `/`):
 * launchd names a loaded job's plist in one spelling, and the ownership check compares it.
 */
export function assertAbsolutePlistPath(path: string): void {
  if (!isAbsoluteNormalPath(path)) {
    throw new LaunchdJobError(
      'INVALID_CONFIG',
      `Plist path must be an absolute, normal path without NUL bytes: ${JSON.stringify(path)}`,
    );
  }
}

/**
 * Validate a `.plist` document (either in-memory `content` on stdin or an
 * absolute file `path`) using `/usr/bin/plutil -lint`.
 *
 * Throws `LaunchdJobError('INVALID_PLIST', ...)` if `plutil` rejects the plist.
 */
export async function lintLaunchdPlist(options: LintLaunchdPlistOptions): Promise<void> {
  const hasContent = options.content !== undefined;
  const hasPath = options.path !== undefined;
  if (hasContent === hasPath) {
    throw new LaunchdJobError(
      'INVALID_CONFIG',
      'lintLaunchdPlist requires exactly one of content or path',
    );
  }
  const adapter = options.adapter ?? createDefaultLaunchdHostAdapter();
  let result: LaunchdCommandResult;
  if (options.content !== undefined) {
    result = await adapter.runCommand(PLUTIL_PATH, ['-lint', '-'], {
      stdin: new TextEncoder().encode(options.content),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
  } else {
    const path = options.path ?? '';
    assertAbsolutePlistPath(path);
    result = await adapter.runCommand(PLUTIL_PATH, ['-lint', path], {
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
  }
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new LaunchdJobError(
      'INVALID_PLIST',
      `plutil -lint rejected plist (exit ${result.exitCode})${detail ? `: ${detail}` : ''}`,
    );
  }
}

function isMissingPlistOutput(text: string): boolean {
  if (/\bCode=257\b/.test(text)) return false;
  return (
    /No such file or directory/i.test(text) ||
    /file does not exist/i.test(text) ||
    /\bCode=260\b/.test(text)
  );
}

/**
 * Read and parse an existing `.plist` file into a plain object using
 * `/usr/bin/plutil -convert json -o - <absPath>`.
 *
 * Returns `null` when the file does not exist (`ENOENT`), and throws
 * `LaunchdJobError('INVALID_PLIST', ...)` on malformed plist / JSON or a
 * non-object top-level value.
 */
export async function readLaunchdPlist(
  options: ReadLaunchdPlistOptions,
): Promise<Record<string, unknown> | null> {
  assertAbsolutePlistPath(options.path);
  const adapter = options.adapter ?? createDefaultLaunchdHostAdapter();
  const existing = await adapter.readFile(options.path);
  if (existing === null) return null;

  const result = await adapter.runCommand(
    PLUTIL_PATH,
    ['-convert', 'json', '-o', '-', options.path],
    options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : undefined,
  );
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    if (isMissingPlistOutput(detail)) return null;
    throw new LaunchdJobError(
      'INVALID_PLIST',
      `plutil failed to read ${options.path} (exit ${result.exitCode})${detail ? `: ${detail}` : ''}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (cause) {
    throw new LaunchdJobError(
      'INVALID_PLIST',
      `plutil returned invalid JSON for ${options.path}`,
      { cause },
    );
  }
  const checked = PlistRecordSchema.safeParse(parsed);
  if (!checked.success) {
    throw new LaunchdJobError(
      'INVALID_PLIST',
      `Plist top-level value at ${options.path} must be a dictionary`,
      { cause: checked.error },
    );
  }
  return checked.data;
}
