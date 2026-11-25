import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CLANG_PATH,
  compileMacosLauncher,
  LAUNCHER_EXIT_NOT_LAUNCHD,
  type MacosCommandRunner,
  MacosLauncherError,
  renderMacosLauncherSource,
} from '../src/entrypoints/service-host/macos';

describe('service-host/macos C11 launcher generation and compilation', () => {
  test('encodes every string as C byte arrays (zero raw string injection), uses posix_spawn, enforces getppid()==1, and ignores runtime argv by default', () => {
    const hostileArg = '"); system("evil"); /* \\ \n';
    const source = renderMacosLauncherSource({
      targetExecutable: '/Users/example-user/.local/bin/daemon',
      fixedArgs: ['--flag', hostileArg],
      workingDirectory: '/Users/example-user/work',
      envOverrides: {
        B_VAR: 'two',
        A_VAR: 'one"/*injected*/',
      },
    });

    expect(source).not.toContain('system("evil")');
    expect(source).not.toContain('/Users/example-user/.local/bin/daemon');
    expect(source).not.toContain('posix_spawnp');
    expect(source).not.toContain('POSIX_SPAWN_SETEXEC');
    expect(source).not.toContain('responsibility_spawnattrs_setdisclaim');

    expect(source).toContain('#define _DARWIN_C_SOURCE');
    expect(source).toContain('#define _POSIX_C_SOURCE 200809L');
    expect(source).toContain('int saved_errno = errno;');
    expect(source).toContain('errno = saved_errno;');
    expect(source).toContain(
      'posix_spawn(&child, k_target, NULL, &attr, child_argv, environ)',
    );
    expect(source).toContain(
      `if (getppid() != 1) {\n    _exit(${LAUNCHER_EXIT_NOT_LAUNCHD});\n  }`,
    );
    expect(source).toContain('(void)argc;');
    expect(source).toContain('(void)argv;');
    expect(source).toContain('if (sigemptyset(&blocked) != 0) _exit(126);');
    expect(source).toContain(
      'if (sigprocmask(SIG_BLOCK, &blocked, &previous) != 0) _exit(126);',
    );
    expect(source).toContain('if (sigaction(SIGTERM, &action, NULL) != 0) _exit(126);');
    expect(source).toContain('if (posix_spawnattr_init(&attr) != 0) _exit(126);');
    expect(source).toContain('while (waited < 0 && errno == EINTR);');
    expect(source).toContain('g_child_pid = 0;');
    expect(source).toContain('if (chdir(k_working_dir) != 0)');
    expect(source).toContain('if (setenv(k_env_key_0, k_env_val_0, 1) != 0)');
  });

  test('supports opt-in forwardArgv and requireLaunchdParent: false', () => {
    const source = renderMacosLauncherSource({
      targetExecutable: '/bin/echo',
      fixedArgs: ['hello'],
      forwardArgv: true,
      requireLaunchdParent: false,
    });

    expect(source).not.toContain('getppid() != 1');
    expect(source).toContain('calloc(total_argc, sizeof(char *))');
    expect(source).toContain('argv[1 + (int)i]');
    expect(source).toContain('free(child_argv);');
  });

  test('enforces strict I10 validation limits on targetExecutable, fixedArgs, and envOverrides', () => {
    expect(() => renderMacosLauncherSource({ targetExecutable: 'relative/path' })).toThrow(
      MacosLauncherError,
    );
    expect(() =>
      renderMacosLauncherSource({ targetExecutable: '/usr/bin/true\0bad' }),
    ).toThrow(MacosLauncherError);
    expect(() =>
      renderMacosLauncherSource({
        targetExecutable: '/usr/bin/true',
        fixedArgs: Array.from({ length: 65 }, (_, i) => String(i)),
      }),
    ).toThrow(MacosLauncherError);
    expect(() =>
      renderMacosLauncherSource({
        targetExecutable: '/usr/bin/true',
        envOverrides: { 'BAD=KEY': 'value' },
      }),
    ).toThrow(MacosLauncherError);
    expect(() =>
      renderMacosLauncherSource({
        targetExecutable: '/usr/bin/true',
        envOverrides: Object.fromEntries(
          Array.from({ length: 65 }, (_, i) => [`K_${i}`, 'v']),
        ),
      }),
    ).toThrow(MacosLauncherError);
  });

  test('compileMacosLauncher invokes /usr/bin/clang with strict C11 hardening flags and cleans up temp staging', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stitchkit-macos-launcher-test-'));
    try {
      const outputPath = join(dir, 'launcher');
      let seenTempSource = '';
      const calls: Array<{ exe: string; args: readonly string[] }> = [];
      const runner: MacosCommandRunner = {
        async runCommand(exe, args) {
          calls.push({ exe, args });
          seenTempSource = args[args.length - 1] ?? '';
          await writeFile(outputPath, 'fake-mach-o', 'utf8');
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      };

      const compiled = await compileMacosLauncher({
        config: { targetExecutable: '/Users/example-user/bin/daemon' },
        outputPath,
        arch: 'arm64',
        runner,
      });

      expect(compiled.outputPath).toBe(outputPath);
      expect(compiled.sourceDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(calls[0]?.exe).toBe(CLANG_PATH);
      expect(calls[0]?.args.slice(0, 9)).toEqual([
        '-std=c11',
        '-O2',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-fstack-protector-strong',
        '-arch',
        'arm64',
        '-o',
      ]);
      // Temporary C source directory must be cleaned up after compilation
      await expect(stat(seenTempSource)).rejects.toThrow();

      // Explicit sourcePath is written verbatim, passed to clang, and preserved after compilation
      const explicitSourcePath = join(dir, 'custom-launcher.c');
      const explicitOutputPath = join(dir, 'custom-launcher');
      const explicitCalls: Array<{ exe: string; args: readonly string[] }> = [];
      const explicitRunner: MacosCommandRunner = {
        async runCommand(exe, args) {
          explicitCalls.push({ exe, args });
          await writeFile(explicitOutputPath, 'fake-mach-o-explicit', 'utf8');
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      };
      const explicitConfig = { targetExecutable: '/Users/example-user/bin/daemon' };
      const compiledExplicit = await compileMacosLauncher({
        config: explicitConfig,
        outputPath: explicitOutputPath,
        sourcePath: explicitSourcePath,
        runner: explicitRunner,
      });
      expect(compiledExplicit.outputPath).toBe(explicitOutputPath);
      expect(explicitCalls[0]?.exe).toBe(CLANG_PATH);
      expect(explicitCalls[0]?.args.at(-1)).toBe(explicitSourcePath);
      expect(await readFile(explicitSourcePath, 'utf8')).toBe(
        renderMacosLauncherSource(explicitConfig),
      );

      // Compile failure throws MacosLauncherError('COMPILE_FAILED')
      const failingRunner: MacosCommandRunner = {
        async runCommand() {
          return { exitCode: 1, stdout: '', stderr: 'clang error: syntax error' };
        },
      };
      await expect(
        compileMacosLauncher({
          config: { targetExecutable: '/Users/example-user/bin/daemon' },
          outputPath,
          runner: failingRunner,
        }),
      ).rejects.toMatchObject({ code: 'COMPILE_FAILED' });

      // Rejects relative or newline-bearing sourcePath / outputPath
      await expect(
        compileMacosLauncher({
          config: { targetExecutable: '/Users/example-user/bin/daemon' },
          outputPath,
          sourcePath: 'relative/launcher.c',
          runner,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
      await expect(
        compileMacosLauncher({
          config: { targetExecutable: '/Users/example-user/bin/daemon' },
          outputPath,
          sourcePath: '/tmp/bad\nlauncher.c',
          runner,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
      await expect(
        compileMacosLauncher({
          config: { targetExecutable: '/Users/example-user/bin/daemon' },
          outputPath: '/tmp/bad\rlauncher',
          runner,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
