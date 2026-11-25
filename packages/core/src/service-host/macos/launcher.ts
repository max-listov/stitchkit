import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { computeSha256Hex } from '../artifact-manifest';
import {
  CLANG_PATH,
  createDefaultMacosCommandRunner,
  type MacosCommandRunner,
} from './runner';

/** Exit code returned by the compiled C launcher when `getppid() != 1` (EX_CONFIG). */
export const LAUNCHER_EXIT_NOT_LAUNCHD = 78;

const MAX_FIXED_ARGS = 64;
const MAX_ENV_OVERRIDES = 64;
const MAX_STRING_BYTES = 4_096;
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Failure classifications thrown by {@link MacosLauncherError}. */
export type MacosLauncherErrorCode = 'INVALID_CONFIG' | 'COMPILE_FAILED';

/** Structured error thrown when validating or compiling a macOS C launcher binary. */
export class MacosLauncherError extends Error {
  readonly code: MacosLauncherErrorCode;

  constructor(code: MacosLauncherErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'MacosLauncherError';
    this.code = code;
  }
}

function byteLengthOf(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/**
 * Zod schema for generating a strict C11 macOS `.app` launcher binary.
 *
 * Defaults are fail-closed against TCC Confused Deputy attacks:
 * - `forwardArgv` defaults to `false` (runtime CLI arguments are ignored unless opted in).
 * - `requireLaunchdParent` defaults to `true` (`getppid() != 1` exits with code 78).
 */
export const MacosLauncherConfigSchema = z
  .strictObject({
    targetExecutable: z.string().min(1),
    fixedArgs: z.array(z.string()).max(MAX_FIXED_ARGS).default([]),
    forwardArgv: z.boolean().default(false),
    requireLaunchdParent: z.boolean().default(true),
    envOverrides: z.record(z.string(), z.string()).optional(),
    workingDirectory: z.string().min(1).optional(),
  })
  .check((ctx) => {
    const value = ctx.value;
    if (
      !value.targetExecutable.startsWith('/') ||
      value.targetExecutable.includes('\0') ||
      byteLengthOf(value.targetExecutable) > MAX_STRING_BYTES
    ) {
      ctx.issues.push({
        code: 'custom',
        input: value.targetExecutable,
        path: ['targetExecutable'],
        message: 'targetExecutable must be an absolute path without NUL bytes (<= 4096 bytes)',
      });
    }
    for (let index = 0; index < value.fixedArgs.length; index += 1) {
      const arg = value.fixedArgs[index] ?? '';
      if (arg.includes('\0') || byteLengthOf(arg) > MAX_STRING_BYTES) {
        ctx.issues.push({
          code: 'custom',
          input: arg,
          path: ['fixedArgs', index],
          message: 'fixedArgs entries must not contain NUL bytes and must be <= 4096 bytes',
        });
      }
    }
    if (value.workingDirectory !== undefined) {
      if (
        !value.workingDirectory.startsWith('/') ||
        value.workingDirectory.includes('\0') ||
        byteLengthOf(value.workingDirectory) > MAX_STRING_BYTES
      ) {
        ctx.issues.push({
          code: 'custom',
          input: value.workingDirectory,
          path: ['workingDirectory'],
          message:
            'workingDirectory must be an absolute path without NUL bytes (<= 4096 bytes)',
        });
      }
    }
    if (value.envOverrides !== undefined) {
      const entries = Object.entries(value.envOverrides);
      if (entries.length > MAX_ENV_OVERRIDES) {
        ctx.issues.push({
          code: 'custom',
          input: value.envOverrides,
          path: ['envOverrides'],
          message: `envOverrides cannot exceed ${MAX_ENV_OVERRIDES} entries`,
        });
      }
      for (const [key, val] of entries) {
        if (!ENV_KEY_PATTERN.test(key) || byteLengthOf(key) > MAX_STRING_BYTES) {
          ctx.issues.push({
            code: 'custom',
            input: key,
            path: ['envOverrides', key],
            message: `Invalid environment variable key: ${JSON.stringify(key)}`,
          });
        }
        if (val.includes('\0') || byteLengthOf(val) > MAX_STRING_BYTES) {
          ctx.issues.push({
            code: 'custom',
            input: val,
            path: ['envOverrides', key],
            message:
              'envOverrides values must not contain NUL bytes and must be <= 4096 bytes',
          });
        }
      }
    }
  });

/** Input configuration accepted by {@link renderMacosLauncherSource}. */
export type MacosLauncherConfig = z.input<typeof MacosLauncherConfigSchema>;

/** Options for {@link compileMacosLauncher}. */
export interface CompileMacosLauncherOptions {
  config: MacosLauncherConfig;
  outputPath: string;
  /** Optional explicit `.c` file path; when omitted, a temporary staging directory is used. */
  sourcePath?: string;
  /** Target CPU architecture passed via `-arch` (defaults to host architecture). */
  arch?: 'arm64' | 'x86_64';
  timeoutMs?: number;
  runner?: MacosCommandRunner;
}

/** Result returned by {@link compileMacosLauncher}. */
export interface CompileMacosLauncherResult {
  outputPath: string;
  sourceDigest: string;
}

function encodeCByteArray(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const parts: string[] = [];
  for (const byte of bytes) {
    parts.push(`0x${byte.toString(16).padStart(2, '0')}`);
  }
  parts.push('0x00');
  return `{ ${parts.join(', ')} }`;
}

/**
 * Render a hardened C11 launcher program that spawns the target executable via
 * `posix_spawn` (never `posix_spawnp`, never `POSIX_SPAWN_SETEXEC`, never
 * responsibility disclaim), encodes all strings as raw byte arrays so C source
 * injection is structurally impossible, checks `getppid() == 1` by default,
 * verifies every syscall return code, forwards termination signals without
 * races, and resets `g_child_pid = 0` once `waitpid` returns.
 */
export function renderMacosLauncherSource(config: MacosLauncherConfig): string {
  const parsedResult = MacosLauncherConfigSchema.safeParse(config);
  if (!parsedResult.success) {
    throw new MacosLauncherError(
      'INVALID_CONFIG',
      `Invalid macOS launcher configuration: ${parsedResult.error.message}`,
      { cause: parsedResult.error },
    );
  }
  const parsed = parsedResult.data;

  const dataDecls: string[] = [
    `static char k_target[] = ${encodeCByteArray(parsed.targetExecutable)};`,
  ];
  for (let index = 0; index < parsed.fixedArgs.length; index += 1) {
    const arg = parsed.fixedArgs[index] ?? '';
    dataDecls.push(`static char k_arg_${index}[] = ${encodeCByteArray(arg)};`);
  }
  if (parsed.workingDirectory !== undefined) {
    dataDecls.push(
      `static char k_working_dir[] = ${encodeCByteArray(parsed.workingDirectory)};`,
    );
  }

  const envEntries =
    parsed.envOverrides === undefined
      ? []
      : Object.entries(parsed.envOverrides).sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0,
        );
  for (let index = 0; index < envEntries.length; index += 1) {
    const entry = envEntries[index];
    if (!entry) continue;
    dataDecls.push(`static char k_env_key_${index}[] = ${encodeCByteArray(entry[0])};`);
    dataDecls.push(`static char k_env_val_${index}[] = ${encodeCByteArray(entry[1])};`);
  }

  const preSpawnLines: string[] = [];
  if (parsed.requireLaunchdParent) {
    preSpawnLines.push(
      '  if (getppid() != 1) {',
      `    _exit(${LAUNCHER_EXIT_NOT_LAUNCHD});`,
      '  }',
    );
  }
  if (parsed.workingDirectory !== undefined) {
    preSpawnLines.push('  if (chdir(k_working_dir) != 0) {', '    _exit(126);', '  }');
  }
  for (let index = 0; index < envEntries.length; index += 1) {
    preSpawnLines.push(
      `  if (setenv(k_env_key_${index}, k_env_val_${index}, 1) != 0) {`,
      '    _exit(126);',
      '  }',
    );
  }

  const argvLines: string[] = [];
  if (!parsed.forwardArgv) {
    const items = [
      'k_target',
      ...parsed.fixedArgs.map((_, index) => `k_arg_${index}`),
      'NULL',
    ];
    argvLines.push('  (void)argc;', '  (void)argv;');
    argvLines.push(`  char *child_argv[] = { ${items.join(', ')} };`);
  } else {
    const fixedCount = 1 + parsed.fixedArgs.length;
    argvLines.push(
      '  size_t extra_argc = (argc > 1) ? (size_t)(argc - 1) : 0;',
      '  if (extra_argc > 4096) {',
      '    _exit(126);',
      '  }',
      `  size_t total_argc = ${fixedCount}u + extra_argc + 1u;`,
      '  char **child_argv = (char **)calloc(total_argc, sizeof(char *));',
      '  if (child_argv == NULL) {',
      '    _exit(126);',
      '  }',
      '  child_argv[0] = k_target;',
    );
    for (let index = 0; index < parsed.fixedArgs.length; index += 1) {
      argvLines.push(`  child_argv[${index + 1}] = k_arg_${index};`);
    }
    argvLines.push(
      '  for (size_t i = 0; i < extra_argc; i++) {',
      `    child_argv[${fixedCount}u + i] = argv[1 + (int)i];`,
      '  }',
      `  child_argv[${fixedCount}u + extra_argc] = NULL;`,
    );
  }

  const freeArgvLine = parsed.forwardArgv ? '  free(child_argv);\n' : '';

  return [
    '#define _DARWIN_C_SOURCE',
    '#define _POSIX_C_SOURCE 200809L',
    '',
    '#include <errno.h>',
    '#include <signal.h>',
    '#include <spawn.h>',
    '#include <stddef.h>',
    '#include <stdint.h>',
    '#include <stdlib.h>',
    '#include <string.h>',
    '#include <sys/wait.h>',
    '#include <unistd.h>',
    '',
    'extern char **environ;',
    '',
    'static volatile sig_atomic_t g_child_pid = 0;',
    '',
    ...dataDecls,
    '',
    'static void forward_signal(int sig) {',
    '  int saved_errno = errno;',
    '  pid_t child = (pid_t)g_child_pid;',
    '  if (child > 0) {',
    '    (void)kill(child, sig);',
    '  }',
    '  errno = saved_errno;',
    '}',
    '',
    'int main(int argc, char **argv) {',
    ...preSpawnLines,
    ...argvLines,
    '  sigset_t blocked;',
    '  sigset_t previous;',
    '  if (sigemptyset(&blocked) != 0) _exit(126);',
    '  if (sigaddset(&blocked, SIGTERM) != 0) _exit(126);',
    '  if (sigaddset(&blocked, SIGINT) != 0) _exit(126);',
    '  if (sigaddset(&blocked, SIGHUP) != 0) _exit(126);',
    '  if (sigaddset(&blocked, SIGQUIT) != 0) _exit(126);',
    '  if (sigprocmask(SIG_BLOCK, &blocked, &previous) != 0) _exit(126);',
    '',
    '  struct sigaction action;',
    '  memset(&action, 0, sizeof(action));',
    '  action.sa_handler = forward_signal;',
    '  if (sigemptyset(&action.sa_mask) != 0) _exit(126);',
    '  action.sa_flags = 0;',
    '  if (sigaction(SIGTERM, &action, NULL) != 0) _exit(126);',
    '  if (sigaction(SIGINT, &action, NULL) != 0) _exit(126);',
    '  if (sigaction(SIGHUP, &action, NULL) != 0) _exit(126);',
    '  if (sigaction(SIGQUIT, &action, NULL) != 0) _exit(126);',
    '',
    '  posix_spawnattr_t attr;',
    '  if (posix_spawnattr_init(&attr) != 0) _exit(126);',
    '  if (posix_spawnattr_setsigmask(&attr, &previous) != 0) {',
    '    (void)posix_spawnattr_destroy(&attr);',
    '    _exit(126);',
    '  }',
    '  if (posix_spawnattr_setflags(&attr, POSIX_SPAWN_SETSIGMASK) != 0) {',
    '    (void)posix_spawnattr_destroy(&attr);',
    '    _exit(126);',
    '  }',
    '',
    '  pid_t child = 0;',
    '  int spawn_rc = posix_spawn(&child, k_target, NULL, &attr, child_argv, environ);',
    '  (void)posix_spawnattr_destroy(&attr);',
    `${freeArgvLine}  if (spawn_rc != 0 || child <= 0) _exit(127);`,
    '',
    '  g_child_pid = (sig_atomic_t)child;',
    '  if (sigprocmask(SIG_SETMASK, &previous, NULL) != 0) {',
    '    (void)kill(child, SIGTERM);',
    '    _exit(126);',
    '  }',
    '',
    '  int status = 0;',
    '  pid_t waited;',
    '  do {',
    '    waited = waitpid(child, &status, 0);',
    '  } while (waited < 0 && errno == EINTR);',
    '  g_child_pid = 0;',
    '  if (waited < 0) _exit(126);',
    '  if (WIFEXITED(status)) return WEXITSTATUS(status);',
    '  if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);',
    '  return 1;',
    '}',
    '',
  ].join('\n');
}

/**
 * Compile a generated C11 macOS `.app` launcher binary using `/usr/bin/clang`
 * with `-std=c11 -O2 -Wall -Wextra -Werror -fstack-protector-strong`.
 */
export async function compileMacosLauncher(
  options: CompileMacosLauncherOptions,
): Promise<CompileMacosLauncherResult> {
  if (!options.outputPath.startsWith('/') || /[\0\r\n]/.test(options.outputPath)) {
    throw new MacosLauncherError(
      'INVALID_CONFIG',
      `Invalid launcher outputPath: ${JSON.stringify(options.outputPath)}`,
    );
  }
  if (
    options.sourcePath !== undefined &&
    (!options.sourcePath.startsWith('/') || /[\0\r\n]/.test(options.sourcePath))
  ) {
    throw new MacosLauncherError(
      'INVALID_CONFIG',
      `Invalid launcher sourcePath: ${JSON.stringify(options.sourcePath)}`,
    );
  }
  const source = renderMacosLauncherSource(options.config);
  const sourceDigest = computeSha256Hex(source);
  const runner = options.runner ?? createDefaultMacosCommandRunner();

  let tempDir: string | undefined;
  let cSourcePath: string;
  if (options.sourcePath !== undefined) {
    cSourcePath = options.sourcePath;
  } else {
    tempDir = await mkdtemp(join(tmpdir(), 'stitchkit-launcher-'));
    cSourcePath = join(tempDir, 'launcher.c');
  }

  try {
    await writeFile(cSourcePath, source, { encoding: 'utf8', mode: 0o600 });
    const args = [
      '-std=c11',
      '-O2',
      '-Wall',
      '-Wextra',
      '-Werror',
      '-fstack-protector-strong',
      ...(options.arch !== undefined ? ['-arch', options.arch] : []),
      '-o',
      options.outputPath,
      cSourcePath,
    ];
    const result = await runner.runCommand(CLANG_PATH, args, {
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
    if (result.exitCode !== 0) {
      throw new MacosLauncherError(
        'COMPILE_FAILED',
        `clang failed to compile macOS launcher (exit ${result.exitCode}): ${result.stderr.trim()}`,
      );
    }
    await chmod(options.outputPath, 0o755).catch(() => undefined);
    return { outputPath: options.outputPath, sourceDigest };
  } finally {
    if (tempDir !== undefined) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
