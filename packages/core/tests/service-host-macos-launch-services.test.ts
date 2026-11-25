import { describe, expect, test } from 'bun:test';
import { homedir } from 'node:os';
import {
  forgetBuildTree,
  forgetRegistration,
  forgetStaleRegistrations,
  isPathWithinDirectory,
  KLS_APPLICATION_NOT_FOUND_ERR,
  LSREGISTER_PATH,
  type MacosCommandRunner,
  normalizeMacosSyntheticPath,
  parseLsregisterDump,
  registerBundle,
  scanLsregisterDump,
} from '../src/entrypoints/service-host/macos';
import { NativeCommandError } from '../src/process/contract';

const SAMPLE_DUMP = [
  '--------------------------------------------------------------------------------',
  'bundle id:        100',
  'path:             /Users/example-user/Applications/Example.app (0x4f00)',
  'identifier:       com.example.daemon (0x80000001)',
  '--------------------------------------------------------------------------------',
  'bundle id:        101',
  'path:             /Users/example-user/old-build/Example.app (0x4f01)',
  'identifier:       com.example.daemon',
  '--------------------------------------------------------------------------------',
  'bundle id:        102',
  'path:             /Applications/Example.app',
  'identifier:       com.example.daemon',
  '--------------------------------------------------------------------------------',
  'bundle id:        103',
  'path:             /System/Library/CoreServices/Finder.app',
  'identifier:       com.example.daemon',
  '--------------------------------------------------------------------------------',
  'bundle id:        104',
  'path:             /private/var/folders/aa/build-dir/Example.app',
  'identifier:       com.example.helper',
  '--------------------------------------------------------------------------------',
  'bundle id:        105',
  'path:             /private/var/folders/aa/build-dir2/Other.app',
  'identifier:       com.example.helper',
].join('\n');

describe('service-host/macos LaunchServices (lsregister)', () => {
  test('registerBundle and forgetRegistration: accepts ONLY -10814 as not-registered and throws on -10815 or other errors', async () => {
    const calls: Array<{ exe: string; args: readonly string[] }> = [];
    let nextResult = { exitCode: 0, stdout: '', stderr: '' };
    const runner: MacosCommandRunner = {
      async runCommand(exe, args) {
        calls.push({ exe, args });
        return nextResult;
      },
    };

    await registerBundle({
      bundlePath: '/Users/example-user/Applications/Example.app',
      runner,
    });
    expect(calls[0]).toEqual({
      exe: LSREGISTER_PATH,
      args: ['-f', '/Users/example-user/Applications/Example.app'],
    });

    expect(
      await forgetRegistration({
        bundlePath: '/Users/example-user/Applications/Example.app',
        runner,
      }),
    ).toBe('unregistered');

    nextResult = {
      exitCode: 1,
      stdout: '',
      stderr: `LSRegisterURL failed with error ${KLS_APPLICATION_NOT_FOUND_ERR}`,
    };
    expect(
      await forgetRegistration({
        bundlePath: '/Users/example-user/Applications/Missing.app',
        runner,
      }),
    ).toBe('not-registered');

    // Non-10814 error (e.g. -10815) MUST throw COMMAND_FAILED!
    nextResult = {
      exitCode: 1,
      stdout: '',
      stderr: 'LSRegisterURL failed with error -10815',
    };
    await expect(
      forgetRegistration({
        bundlePath: '/Users/example-user/Applications/Broken.app',
        runner,
      }),
    ).rejects.toMatchObject({ code: 'COMMAND_FAILED' });
    // Path containing "-10814" must NOT fake not-registered when another error occurs
    nextResult = {
      exitCode: 1,
      stdout: '',
      stderr:
        'LSRegisterURL failed for /Users/example-user/build-10814/App.app: permission denied (-50)',
    };
    await expect(
      forgetRegistration({
        bundlePath: '/Users/example-user/build-10814/App.app',
        runner,
      }),
    ).rejects.toMatchObject({ code: 'COMMAND_FAILED' });

    // Path traversal inside isPathWithinDirectory is normalized away
    expect(isPathWithinDirectory('/tmp/build/../Applications/Foo.app', '/tmp/build')).toBe(
      false,
    );
  });

  test('streams lsregister -dump in arbitrary UTF-8 chunks with O(1) parser, first-wins semantics, overlong line cap, and COMMAND_LIMIT translation', async () => {
    expect(parseLsregisterDump(SAMPLE_DUMP)).toEqual([
      {
        path: '/Users/example-user/Applications/Example.app',
        bundleIdentifier: 'com.example.daemon',
      },
      {
        path: '/Users/example-user/old-build/Example.app',
        bundleIdentifier: 'com.example.daemon',
      },
      { path: '/Applications/Example.app', bundleIdentifier: 'com.example.daemon' },
      {
        path: '/System/Library/CoreServices/Finder.app',
        bundleIdentifier: 'com.example.daemon',
      },
      {
        path: '/private/var/folders/aa/build-dir/Example.app',
        bundleIdentifier: 'com.example.helper',
      },
      {
        path: '/private/var/folders/aa/build-dir2/Other.app',
        bundleIdentifier: 'com.example.helper',
      },
    ]);

    const rawBytes = new TextEncoder().encode(SAMPLE_DUMP);
    const streamingRunner: MacosCommandRunner = {
      async runCommand(_exe, _args, opts) {
        if (opts?.onOutput) {
          // Deliver in tiny 19-byte chunks slicing across lines
          for (let offset = 0; offset < rawBytes.byteLength; offset += 19) {
            await opts.onOutput(rawBytes.subarray(offset, offset + 19), 'stdout');
          }
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    };

    const records: string[] = [];
    const scanned = await scanLsregisterDump({
      runner: streamingRunner,
      onRecord(record) {
        records.push(record.path);
      },
    });
    expect(scanned.recordCount).toBe(6);
    expect(scanned.totalBytes).toBe(rawBytes.byteLength);
    expect(records).toHaveLength(6);

    await expect(
      scanLsregisterDump({
        runner: streamingRunner,
        maxDumpBytes: 64,
        onRecord: () => undefined,
      }),
    ).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });

    // NativeCommandError('COMMAND_LIMIT') from runner is translated to LIMIT_EXCEEDED
    const limitRunner: MacosCommandRunner = {
      async runCommand() {
        throw new NativeCommandError('COMMAND_LIMIT', 'output budget exceeded', {
          reason: 'output-budget',
        });
      },
    };
    await expect(
      scanLsregisterDump({ runner: limitRunner, onRecord: () => undefined }),
    ).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });

    // First-wins within a section, NUL path rejection, and >65536 char line skipping
    const trickyDump = [
      '--------------------------------------------------------------------------------',
      'path:        /Users/example-user/First.app (0x1)',
      'identifier:  com.example.first',
      'path:        /Users/example-user/NestedPlugin.appex (0x2)',
      'identifier:  com.example.nested',
      '--------------------------------------------------------------------------------',
      'path:        /Users/example-user/Bad\0Null.app',
      'identifier:  com.example.null',
      '--------------------------------------------------------------------------------',
      `notes:       ${'x'.repeat(70_000)}`,
      'path:        /Users/example-user/AfterLongLine.app',
      'identifier:  com.example.after',
    ].join('\n');
    expect(parseLsregisterDump(trickyDump)).toEqual([
      { path: '/Users/example-user/First.app', bundleIdentifier: 'com.example.first' },
      { path: '/Users/example-user/AfterLongLine.app', bundleIdentifier: 'com.example.after' },
    ]);
  });

  test('forgetStaleRegistrations is fail-closed without filter, protects system roots, honors keepPaths and maxUnregistrations', async () => {
    const unregisteredPaths: string[] = [];
    const runner: MacosCommandRunner = {
      async runCommand(_exe, args) {
        if (args[0] === '-dump') return { exitCode: 0, stdout: SAMPLE_DUMP, stderr: '' };
        if (args[0] === '-u') {
          unregisteredPaths.push(args[1] ?? '');
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        return { exitCode: 1, stdout: '', stderr: 'unexpected' };
      },
    };

    // Fail-closed without bundleId or bundleIdPrefix
    await expect(forgetStaleRegistrations({ runner })).rejects.toMatchObject({
      code: 'INVALID_OPTIONS',
    });
    await expect(
      forgetStaleRegistrations({ bundleIdPrefix: 'com.example.*', runner }),
    ).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });

    const existing = new Set(['/Users/example-user/Applications/Example.app']);
    const result = await forgetStaleRegistrations({
      bundleId: 'com.example.daemon',
      keepPaths: ['/Users/example-user/Applications/Example.app'],
      pathExists: async (p) => existing.has(p),
      realpathFn: async (p) => p,
      runner,
    });

    expect(result.unregistered).toEqual(['/Users/example-user/old-build/Example.app']);
    expect(result.skippedProtected).toEqual([
      '/Applications/Example.app',
      '/System/Library/CoreServices/Finder.app',
    ]);
    expect(unregisteredPaths).toEqual(['/Users/example-user/old-build/Example.app']);

    // Enforce maxUnregistrations BEFORE mutating
    unregisteredPaths.length = 0;
    await expect(
      forgetStaleRegistrations({
        bundleIdPrefix: 'com.example.',
        maxUnregistrations: 1,
        pathExists: async () => false,
        realpathFn: async (p) => p,
        runner,
      }),
    ).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    expect(unregisteredPaths).toEqual([]);
  });

  test('forgetBuildTree refuses root/system directories, canonicalizes /var <-> /private/var, and avoids sibling prefix collisions', async () => {
    const unregisteredPaths: string[] = [];
    const runner: MacosCommandRunner = {
      async runCommand(_exe, args) {
        if (args[0] === '-dump') return { exitCode: 0, stdout: SAMPLE_DUMP, stderr: '' };
        if (args[0] === '-u') {
          unregisteredPaths.push(args[1] ?? '');
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        return { exitCode: 1, stdout: '', stderr: 'unexpected' };
      },
    };

    for (const forbidden of [
      '/',
      '/System',
      '/Applications',
      '/Users',
      '//Users',
      '/Users/example-user',
      homedir(),
      '/Users/example-user/build/..',
      '/var',
      '/private/var',
      '/tmp',
    ]) {
      await expect(
        forgetBuildTree({ buildDir: forbidden, runner, realpathFn: async (p) => p }),
      ).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
    }

    // Symlink resolving into /Applications is protected and never unregistered
    unregisteredPaths.length = 0;
    const symlinkDump = [
      '--------------------------------------------------------------------------------',
      'path:        /Users/example-user/build/LinkToApp.app',
      'identifier:  com.example.daemon',
    ].join('\n');
    const symlinkRunner: MacosCommandRunner = {
      async runCommand(_exe, args) {
        if (args[0] === '-dump') return { exitCode: 0, stdout: symlinkDump, stderr: '' };
        unregisteredPaths.push(args[1] ?? '');
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    };
    const symlinkRes = await forgetStaleRegistrations({
      bundleId: 'com.example.daemon',
      pathExists: async () => false,
      realpathFn: async (p) =>
        p === '/Users/example-user/build/LinkToApp.app' ? '/Applications/Real.app' : p,
      runner: symlinkRunner,
    });
    expect(symlinkRes.unregistered).toEqual([]);
    expect(symlinkRes.skippedProtected).toEqual(['/Users/example-user/build/LinkToApp.app']);
    expect(unregisteredPaths).toEqual([]);

    const res = await forgetBuildTree({
      buildDir: '/var/folders/aa/build-dir',
      runner,
      realpathFn: async (p) => p,
    });
    expect(res.unregistered).toEqual(['/private/var/folders/aa/build-dir/Example.app']);
    expect(unregisteredPaths).toEqual(['/private/var/folders/aa/build-dir/Example.app']);
  });

  test('APFS case-insensitivity protects lowercase/mixed-case system roots, home roots, keepPaths, and synthetic prefixes', async () => {
    expect(normalizeMacosSyntheticPath('/VAR/folders/aa')).toBe('/private/VAR/folders/aa');
    expect(normalizeMacosSyntheticPath('/Tmp/work')).toBe('/private/Tmp/work');
    expect(normalizeMacosSyntheticPath('/ETC/hosts')).toBe('/private/ETC/hosts');
    expect(
      isPathWithinDirectory(
        '/Private/Var/Folders/AA/Build-Dir/Example.app',
        '/var/folders/aa/build-dir',
      ),
    ).toBe(true);
    expect(
      isPathWithinDirectory(
        '/Private/Var/Folders/AA/Build-Dir2/Other.app',
        '/var/folders/aa/build-dir',
      ),
    ).toBe(false);

    const mixedCaseDump = [
      '--------------------------------------------------------------------------------',
      'path:        /system/Library/CoreServices/Finder.app',
      'identifier:  com.example.daemon',
      '--------------------------------------------------------------------------------',
      'path:        /applications/Example.app',
      'identifier:  com.example.daemon',
      '--------------------------------------------------------------------------------',
      'path:        /users/example-user/applications/example.app',
      'identifier:  com.example.daemon',
      '--------------------------------------------------------------------------------',
      'path:        /Users/example-user/stale-build/Example.app',
      'identifier:  com.example.daemon',
    ].join('\n');

    const unregistered: string[] = [];
    const runner: MacosCommandRunner = {
      async runCommand(_exe, args) {
        if (args[0] === '-dump') return { exitCode: 0, stdout: mixedCaseDump, stderr: '' };
        if (args[0] === '-u') {
          unregistered.push(args[1] ?? '');
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        return { exitCode: 1, stdout: '', stderr: 'unexpected' };
      },
    };

    const stale = await forgetStaleRegistrations({
      bundleId: 'com.example.daemon',
      keepPaths: ['/Users/example-user/Applications/Example.app'],
      pathExists: async () => false,
      realpathFn: async (p) => p,
      runner,
    });
    expect(stale.skippedProtected).toEqual([
      '/system/Library/CoreServices/Finder.app',
      '/applications/Example.app',
    ]);
    expect(stale.unregistered).toEqual(['/Users/example-user/stale-build/Example.app']);
    expect(unregistered).toEqual(['/Users/example-user/stale-build/Example.app']);

    for (const forbidden of [
      '/system',
      '/SYSTEM/Library',
      '/applications',
      '/APPLICATIONS/Foo',
      '/library',
      '/users',
      '/users/example-user',
      '/USERS/Example-User',
      '/private/USERS/example-user',
      '/VAR',
      '/PRIVATE/VAR',
      '/TMP',
      '/ETC',
      homedir().toUpperCase(),
    ]) {
      await expect(
        forgetBuildTree({ buildDir: forbidden, runner, realpathFn: async (p) => p }),
      ).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
    }
  });
});
