import { lstat, readlink, realpath, unlink } from 'node:fs/promises';
import { basename, dirname, join, posix } from 'node:path';
import { RegularFileError, readRegularFile } from '../files/regular-file';
import { writeFileAtomic } from '../internal/atomic-file';
import { errnoOf } from '../internal/errno';
import { runNativeCommand } from '../process/command';

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * The `PATH` a host command runs with. The command itself is named by its absolute path;
 * this only serves what it starts in turn (Debian's `systemctl enable` reaches
 * `/usr/sbin/update-rc.d` through `systemd-sysv-install`), and never the caller's own `PATH`.
 */
const HOST_COMMAND_PATH = '/usr/sbin:/usr/bin:/sbin:/bin';

/**
 * The caller's keys a host command receives: its home, and what `systemctl --user` needs to
 * reach the user's manager outside a login session.
 */
const HOST_COMMAND_SESSION_KEYS: readonly string[] = [
  'HOME',
  'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS',
];

/** The declared environment of a host command: the fixed `PATH` plus the session keys set now. */
function hostCommandEnv(): Record<string, string> {
  const env: Record<string, string> = { PATH: HOST_COMMAND_PATH };
  for (const key of HOST_COMMAND_SESSION_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** Options for {@link createBaseServiceHostAdapter}. */
export interface BaseServiceHostAdapterOptions {
  /** Default POSIX file mode applied when `writeFileAtomic` omits `options.mode`. */
  defaultFileMode: number;
  /**
   * When `true`, `readFile` returns `null` on non-regular files (e.g. systemd's
   * `/dev/null` mask symlinks); when `false`, only `ENOENT` returns `null`.
   */
  nullOnNonRegularFile?: boolean;
}

/**
 * Whether `path` is absolute and in normal form — no `//`, `/./`, `/../`, trailing `/` or NUL —
 * the one spelling launchd and systemd report back for a file they loaded.
 */
export function isAbsoluteNormalPath(path: string): boolean {
  return (
    path.startsWith('/') &&
    !path.includes('\0') &&
    posix.normalize(path) === path &&
    !(path.length > 1 && path.endsWith('/'))
  );
}

/**
 * `path` with every symbolic link in its directories resolved and its last component as given:
 * the spelling launchd and systemd may report for a file reached through a linked directory
 * (`/tmp` → `/private/tmp` on macOS). The last component stays: a link there is refused, not
 * followed. A directory that does not exist leaves `path` as it is.
 */
export async function canonicalHostPath(path: string): Promise<string> {
  try {
    return join(await realpath(dirname(path)), basename(path));
  } catch (cause) {
    const code = errnoOf(cause);
    if (code === 'ENOENT' || code === 'ENOTDIR') return path;
    throw cause;
  }
}

/** Whether a path a host manager reports names the same place as `path`, links in directories resolved. */
export async function sameHostPath(
  adapter: { canonicalPath(path: string): Promise<string> },
  reported: string,
  path: string,
): Promise<boolean> {
  if (reported === path) return true;
  return (await adapter.canonicalPath(reported)) === (await adapter.canonicalPath(path));
}

/**
 * What stands at a unit or plist path, without following a link: nothing, a regular file
 * with its permission bits (`mode & 0o7777`), a symbolic link with its target, or another
 * kind of node.
 */
export type ServiceHostPathState =
  | { readonly kind: 'missing' }
  | { readonly kind: 'file'; readonly mode: number }
  | { readonly kind: 'symlink'; readonly target: string }
  | { readonly kind: 'other' };

/** Shared host operations reused by the default `systemd` and `launchd` adapters. */
export interface BaseServiceHostAdapter {
  runCommand(
    executable: string,
    args: readonly string[],
    options?: { timeoutMs?: number; stdin?: Uint8Array },
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  readFile(path: string): Promise<Uint8Array | null>;
  writeFileAtomic(
    path: string,
    content: string | Uint8Array,
    options?: { mode?: number },
  ): Promise<void>;
  removeFile(path: string): Promise<void>;
  /** What stands at `path`, by `lstat`: an apply refuses a link and restores a file's mode. */
  inspectPath(path: string): Promise<ServiceHostPathState>;
  /** `path` with every symbolic link in its directories resolved (see {@link canonicalHostPath}). */
  canonicalPath(path: string): Promise<string>;
  now(): number;
  sleep(ms: number): Promise<void>;
}

function isNonRegularFileError(error: unknown): boolean {
  return error instanceof RegularFileError && error.reason === 'not-regular';
}

/**
 * Create the shared command execution and atomic file I/O base used by
 * `createDefaultSystemdHostAdapter` and `createDefaultLaunchdHostAdapter`. A command runs
 * with a declared environment only: `PATH=/usr/sbin:/usr/bin:/sbin:/bin` and the caller's
 * `HOME`, `XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS` when set; nothing else passes.
 */
export function createBaseServiceHostAdapter(
  adapterOptions: BaseServiceHostAdapterOptions,
): BaseServiceHostAdapter {
  const decoder = new TextDecoder();
  const nullOnNonRegular = adapterOptions.nullOnNonRegularFile ?? false;
  return {
    async runCommand(executable, args, options) {
      const result = await runNativeCommand({
        executable,
        args: [...args],
        envPolicy: 'declared-only',
        env: hostCommandEnv(),
        capture: true,
        maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
        timeoutMs: options?.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
        ...(options?.stdin !== undefined ? { stdin: options.stdin } : {}),
      });
      return {
        exitCode: result.exitCode ?? 1,
        stdout: decoder.decode(result.stdout),
        stderr: decoder.decode(result.stderr),
      };
    },
    async readFile(path) {
      try {
        return await readRegularFile(path);
      } catch (cause) {
        if (
          errnoOf(cause) === 'ENOENT' ||
          (nullOnNonRegular && isNonRegularFileError(cause))
        ) {
          return null;
        }
        throw cause;
      }
    },
    async writeFileAtomic(path, content, options) {
      await writeFileAtomic(path, content, {
        mode: options?.mode ?? adapterOptions.defaultFileMode,
      });
    },
    async removeFile(path) {
      try {
        await unlink(path);
      } catch (cause) {
        if (errnoOf(cause) !== 'ENOENT') throw cause;
      }
    },
    canonicalPath: canonicalHostPath,
    async inspectPath(path) {
      let info: Awaited<ReturnType<typeof lstat>>;
      try {
        info = await lstat(path);
      } catch (cause) {
        if (errnoOf(cause) === 'ENOENT') return { kind: 'missing' };
        throw cause;
      }
      if (info.isSymbolicLink()) return { kind: 'symlink', target: await readlink(path) };
      if (info.isFile()) return { kind: 'file', mode: info.mode & 0o7777 };
      return { kind: 'other' };
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}
