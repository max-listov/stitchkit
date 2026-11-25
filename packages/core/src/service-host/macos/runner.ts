import { realpath } from 'node:fs/promises';
import { posix } from 'node:path';
import { runNativeCommand } from '../../process/command';

/** Absolute path to macOS `codesign`. */
export const CODESIGN_PATH = '/usr/bin/codesign';

/** Absolute path to macOS `security`. */
export const SECURITY_PATH = '/usr/bin/security';

/** Absolute path to macOS `clang`. */
export const CLANG_PATH = '/usr/bin/clang';

/** Absolute path to macOS `sips`. */
export const SIPS_PATH = '/usr/bin/sips';

/** Absolute path to macOS `qlmanage`. */
export const QLMANAGE_PATH = '/usr/bin/qlmanage';

/** Absolute path to macOS `iconutil`. */
export const ICONUTIL_PATH = '/usr/bin/iconutil';

/** Absolute path to macOS `ps`. */
export const PS_PATH = '/bin/ps';

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_STREAMED_STDERR_BYTES = 64 * 1024;

/** Result of invoking one macOS host utility. */
export interface MacosCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Options accepted by {@link MacosCommandRunner.runCommand}. */
export interface MacosCommandOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
  stdin?: Uint8Array;
  cwd?: string;
  /** Keys added to the declared environment (see {@link createDefaultMacosCommandRunner}); they win over it. */
  env?: Record<string, string>;
  /**
   * Optional streaming sink. When provided, stdout is delivered incrementally
   * without buffering the full output in memory (used by `lsregister -dump`).
   */
  onOutput?: (chunk: Uint8Array, channel: 'stdout' | 'stderr') => void | Promise<void>;
}

/**
 * Injectable command runner for macOS host utilities (`codesign`, `security`,
 * `clang`, `sips`, `iconutil`, `lsregister`, `ps`, `plutil`).
 */
export interface MacosCommandRunner {
  runCommand(
    executable: string,
    args: readonly string[],
    options?: MacosCommandOptions,
  ): Promise<MacosCommandResult>;
}

/** The PATH of every macOS host command: the system tool directories, never the caller's. */
const MACOS_COMMAND_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

/**
 * The caller's keys a macOS host command receives, each only when set: its home (the user's
 * keychains and preferences `security` and `codesign` read), its temporary directory (clang
 * writes its temporary files under `TMPDIR`, clang(1)), and the selectors xcrun(1) reads to
 * choose the developer directory, SDK and toolchain behind `/usr/bin/clang`.
 */
const MACOS_COMMAND_KEYS = [
  'HOME',
  'TMPDIR',
  'DEVELOPER_DIR',
  'SDKROOT',
  'TOOLCHAINS',
] as const;

function macosCommandEnv(extra: Record<string, string> | undefined): Record<string, string> {
  const env: Record<string, string> = { PATH: MACOS_COMMAND_PATH };
  for (const key of MACOS_COMMAND_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extra };
}

/**
 * Create the default macOS command runner backed by `runNativeCommand`,
 * supporting stdin delivery, bounded capture, and O(1)-memory streaming via
 * `onOutput`. A command runs with a declared environment only: `PATH` is
 * `/usr/bin:/bin:/usr/sbin:/sbin`, and `HOME`, `TMPDIR`, `DEVELOPER_DIR`,
 * `SDKROOT` and `TOOLCHAINS` pass when the caller has them; the call's `env`
 * is added on top, and nothing else of the caller's environment passes.
 */
export function createDefaultMacosCommandRunner(): MacosCommandRunner {
  const decoder = new TextDecoder();
  return {
    async runCommand(executable, args, options) {
      const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const env = macosCommandEnv(options?.env);

      if (options?.onOutput !== undefined) {
        const sink = options.onOutput;
        const stderrChunks: Uint8Array[] = [];
        let stderrBytes = 0;

        const result = await runNativeCommand({
          executable,
          args: [...args],
          envPolicy: 'declared-only',
          env,
          capture: false,
          timeoutMs,
          ...(options.maxOutputBytes !== undefined
            ? { maxOutputBytes: options.maxOutputBytes }
            : {}),
          ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
          ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
          async onOutput(bytes, channel) {
            if (channel === 'stderr' && stderrBytes < MAX_STREAMED_STDERR_BYTES) {
              const remaining = MAX_STREAMED_STDERR_BYTES - stderrBytes;
              const slice =
                bytes.byteLength <= remaining ? bytes : bytes.subarray(0, remaining);
              stderrChunks.push(slice.slice());
              stderrBytes += slice.byteLength;
            }
            await sink(bytes, channel);
          },
        });

        const stderrCombined = new Uint8Array(stderrBytes);
        let offset = 0;
        for (const chunk of stderrChunks) {
          stderrCombined.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return {
          exitCode: result.exitCode ?? 1,
          stdout: '',
          stderr: decoder.decode(stderrCombined),
        };
      }

      const result = await runNativeCommand({
        executable,
        args: [...args],
        envPolicy: 'declared-only',
        env,
        capture: true,
        maxOutputBytes: options?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
        timeoutMs,
        ...(options?.stdin !== undefined ? { stdin: options.stdin } : {}),
        ...(options?.cwd !== undefined ? { cwd: options.cwd } : {}),
      });

      return {
        exitCode: result.exitCode ?? 1,
        stdout: decoder.decode(result.stdout),
        stderr: decoder.decode(result.stderr),
      };
    },
  };
}

/** Normalize POSIX segments, trailing slashes, and macOS `/var`, `/tmp`, `/etc` firmlink prefixes. */
export function normalizeMacosSyntheticPath(targetPath: string): string {
  const normalized = posix.normalize(targetPath).replace(/\/+$/, '');
  if (normalized.length === 0) return '/';
  const lowered = normalized.toLowerCase();
  if (
    lowered === '/var' ||
    lowered.startsWith('/var/') ||
    lowered === '/tmp' ||
    lowered.startsWith('/tmp/') ||
    lowered === '/etc' ||
    lowered.startsWith('/etc/')
  ) {
    return `/private${normalized}`;
  }
  return normalized;
}

/** Case-folded synthetic-normalized path key for APFS case-insensitive comparisons. */
export function macosPathKey(targetPath: string): string {
  return normalizeMacosSyntheticPath(targetPath).toLowerCase();
}

/** Canonicalize a macOS path via `realpath` when present, falling back to symlink-prefix normalization. */
export async function canonicalizeMacosPath(
  targetPath: string,
  realpathFn: (path: string) => Promise<string> = realpath,
): Promise<string> {
  try {
    return normalizeMacosSyntheticPath(await realpathFn(targetPath));
  } catch {
    return normalizeMacosSyntheticPath(targetPath);
  }
}

/** Return `true` iff `candidate` equals `directory` or is strictly nested inside it (APFS case-insensitive). */
export function isPathWithinDirectory(candidate: string, directory: string): boolean {
  const normCandidate = macosPathKey(candidate);
  const normDir = macosPathKey(directory);
  if (normDir === '/') return normCandidate.startsWith('/');
  return normCandidate === normDir || normCandidate.startsWith(`${normDir}/`);
}

const APPLICATIONS_PREFIX = '/applications/';
const PROTECTED_SYSTEM_PREFIXES = [
  '/system/',
  APPLICATIONS_PREFIX,
  '/library/apple/',
  '/usr/',
  '/bin/',
  '/sbin/',
];

const FORBIDDEN_BUILD_ROOTS = new Set(
  '/ /system /applications /library /library/apple /users /var /private /private/var /tmp /private/tmp /etc /private/etc /usr /bin /sbin'.split(
    ' ',
  ),
);

const USER_HOME_ROOT_PATTERN = /^\/users\/[^/]+$/;

/**
 * Return `true` iff `targetPath` points at or inside a protected macOS system root (APFS
 * case-insensitive). `/Applications` is protected unless `applications: 'install-target'`:
 * an app bundle is installed there, nothing else is built, registered or removed there.
 */
export function isProtectedMacosSystemPath(
  targetPath: string,
  options: { applications: 'protected' | 'install-target' } = { applications: 'protected' },
): boolean {
  const normalized = (posix.normalize(targetPath).replace(/\/+$/, '') || '/').toLowerCase();
  const synthetic = macosPathKey(targetPath);
  return PROTECTED_SYSTEM_PREFIXES.some((prefix) => {
    if (prefix === APPLICATIONS_PREFIX && options.applications === 'install-target')
      return false;
    const root = prefix.slice(0, -1);
    return (
      normalized === root ||
      normalized.startsWith(prefix) ||
      synthetic === root ||
      synthetic.startsWith(prefix)
    );
  });
}

/** Return `true` iff `targetPath` is a root, system directory, or top-level `/Users/<name>` home root (APFS case-insensitive). */
export function isMacosForbiddenBuildRoot(targetPath: string): boolean {
  const rawLower = (posix.normalize(targetPath).replace(/\/+$/, '') || '/').toLowerCase();
  const syntheticLower = macosPathKey(targetPath);
  if (
    FORBIDDEN_BUILD_ROOTS.has(rawLower) ||
    FORBIDDEN_BUILD_ROOTS.has(syntheticLower) ||
    isProtectedMacosSystemPath(targetPath)
  ) {
    return true;
  }
  const strippedRaw = rawLower.startsWith('/private/')
    ? rawLower.slice('/private'.length)
    : rawLower;
  const strippedSynthetic = syntheticLower.startsWith('/private/')
    ? syntheticLower.slice('/private'.length)
    : syntheticLower;
  return (
    USER_HOME_ROOT_PATTERN.test(strippedRaw) || USER_HOME_ROOT_PATTERN.test(strippedSynthetic)
  );
}
