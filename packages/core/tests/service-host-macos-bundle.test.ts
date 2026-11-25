import { describe, expect, test } from 'bun:test';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BUNDLE_SPEC_DIGEST_PLIST_KEY,
  CLANG_PATH,
  CODESIGN_PATH,
  computeBundleSpecDigest,
  type EnsureSignedBundleOptions,
  ensureSignedBundle,
  type MacosBundleHostAdapter,
  MacosBundleInstallError,
  type MacosCommandRunner,
  renderBundleInfoPlist,
  renderMacosLauncherSource,
} from '../src/entrypoints/service-host/macos';
import { isProtectedMacosSystemPath } from '../src/service-host/macos/runner';

const VALID_DEV_ID = 'Developer ID Application: Example Corp (A1B2C3D4E5)';

function codesignDvvvStderr(bundleId: string, cdHash: string): string {
  return [
    `Identifier=${bundleId}`,
    'CodeDirectory v=20500 size=512 flags=0x10000(runtime) hashes=10+3 location=embedded',
    `CDHash=${cdHash}`,
    'Signature size=9024',
    `Authority=${VALID_DEV_ID}`,
    'Authority=Developer ID Certification Authority',
    'Authority=Apple Root CA',
    'TeamIdentifier=A1B2C3D4E5',
  ].join('\n');
}

function parseDigestFromInfoPlistXml(xml: string): Record<string, unknown> {
  const match = new RegExp(
    `<key>${BUNDLE_SPEC_DIGEST_PLIST_KEY}</key>\\s*<string>([0-9a-f]{64})</string>`,
  ).exec(xml);
  return match?.[1] !== undefined ? { [BUNDLE_SPEC_DIGEST_PLIST_KEY]: match[1] } : {};
}

const noopAsync = async (): Promise<void> => undefined;

async function swapTwoDirs(fromPath: string, toPath: string): Promise<void> {
  const tempPath = `${fromPath}.swap-tmp-${Math.random().toString(16).slice(2)}`;
  await rename(toPath, tempPath);
  await rename(fromPath, toPath);
  await rename(tempPath, fromPath);
}

describe('service-host/macos bundle Info.plist and ensureSignedBundle', () => {
  test('renderBundleInfoPlist embeds StitchkitBundleSpecDigest and computeBundleSpecDigest detects config drift', () => {
    const baseSpec: EnsureSignedBundleOptions = {
      bundlePath: '/Users/example-user/Applications/Example.app',
      bundleIdentifier: 'com.example.daemon',
      bundleName: 'Example Daemon',
      executableName: 'example-launcher',
      launcher: {
        targetExecutable: '/Users/example-user/.local/bin/daemon',
        fixedArgs: ['--serve'],
      },
    };
    const digestA = computeBundleSpecDigest(
      baseSpec,
      renderMacosLauncherSource(baseSpec.launcher),
    );
    const drifted: EnsureSignedBundleOptions = {
      ...baseSpec,
      launcher: {
        targetExecutable: '/Users/example-user/.local/bin/daemon',
        fixedArgs: ['--serve', '--port', '9000'],
      },
    };
    const digestB = computeBundleSpecDigest(
      drifted,
      renderMacosLauncherSource(drifted.launcher),
    );
    expect(digestA).not.toBe(digestB);

    const plist = renderBundleInfoPlist({
      bundleIdentifier: 'com.example.daemon',
      bundleName: 'Example Daemon',
      displayName: 'Example Daemon',
      executableName: 'example-launcher',
      iconFile: 'AppIcon',
      specDigest: digestA,
    });
    expect(plist).toContain(
      `<key>${BUNDLE_SPEC_DIGEST_PLIST_KEY}</key>\n    <string>${digestA}</string>`,
    );
    expect(plist).toContain('<key>CFBundleIconFile</key>\n    <string>AppIcon</string>');

    for (const forbiddenKey of [
      BUNDLE_SPEC_DIGEST_PLIST_KEY,
      'CFBundleIdentifier',
      'CFBundleExecutable',
      'LSBackgroundOnly',
    ]) {
      expect(() =>
        renderBundleInfoPlist({
          bundleIdentifier: 'com.example.daemon',
          bundleName: 'Example Daemon',
          executableName: 'example-launcher',
          specDigest: digestA,
          extraEntries: { [forbiddenKey]: 'forged' },
        }),
      ).toThrow();
    }
  });

  test('renderBundleInfoPlist renders every MacosBundleInfoPlistConfig option including boolean toggles, versions, icon, digest, and extraEntries', () => {
    const digest = 'a'.repeat(64);
    const fullPlist = renderBundleInfoPlist({
      bundleIdentifier: 'com.example.full',
      bundleName: 'Full Bundle',
      displayName: 'Full Display Name',
      executableName: 'full-launcher',
      bundleVersion: '42',
      shortVersionString: '2.3.4',
      iconFile: 'CustomIcon',
      lsUIElement: true,
      lsBackgroundOnly: true,
      lsMinimumSystemVersion: '14.0',
      specDigest: digest,
      extraEntries: {
        CustomNote: 'alpha',
        CustomFlag: true,
        CustomRetries: 3,
      },
    });

    expect(fullPlist).toContain(
      '<key>CFBundleIdentifier</key>\n    <string>com.example.full</string>',
    );
    expect(fullPlist).toContain('<key>CFBundleName</key>\n    <string>Full Bundle</string>');
    expect(fullPlist).toContain(
      '<key>CFBundleDisplayName</key>\n    <string>Full Display Name</string>',
    );
    expect(fullPlist).toContain(
      '<key>CFBundleExecutable</key>\n    <string>full-launcher</string>',
    );
    expect(fullPlist).toContain('<key>CFBundleVersion</key>\n    <string>42</string>');
    expect(fullPlist).toContain(
      '<key>CFBundleShortVersionString</key>\n    <string>2.3.4</string>',
    );
    expect(fullPlist).toContain(
      '<key>CFBundleIconFile</key>\n    <string>CustomIcon</string>',
    );
    expect(fullPlist).toContain('<key>LSUIElement</key>\n    <true/>');
    expect(fullPlist).toContain('<key>LSBackgroundOnly</key>\n    <true/>');
    expect(fullPlist).toContain(
      '<key>LSMinimumSystemVersion</key>\n    <string>14.0</string>',
    );
    expect(fullPlist).toContain(
      `<key>${BUNDLE_SPEC_DIGEST_PLIST_KEY}</key>\n    <string>${digest}</string>`,
    );
    expect(fullPlist).toContain('<key>CustomFlag</key>\n    <true/>');
    expect(fullPlist).toContain('<key>CustomNote</key>\n    <string>alpha</string>');
    expect(fullPlist).toContain('<key>CustomRetries</key>\n    <integer>3</integer>');

    // Negative / toggle control: toggling booleans to false and changing versions/optional fields
    const toggledDigest = 'b'.repeat(64);
    const toggledPlist = renderBundleInfoPlist({
      bundleIdentifier: 'com.example.toggled',
      bundleName: 'Toggled Bundle',
      executableName: 'toggled-launcher',
      bundleVersion: '99',
      shortVersionString: '3.0.0',
      lsUIElement: false,
      lsBackgroundOnly: false,
      lsMinimumSystemVersion: '15.2',
      specDigest: toggledDigest,
    });

    expect(toggledPlist).toContain('<key>LSUIElement</key>\n    <false/>');
    expect(toggledPlist).not.toContain('<key>LSUIElement</key>\n    <true/>');
    expect(toggledPlist).toContain('<key>LSBackgroundOnly</key>\n    <false/>');
    expect(toggledPlist).not.toContain('<key>LSBackgroundOnly</key>\n    <true/>');
    expect(toggledPlist).toContain(
      '<key>LSMinimumSystemVersion</key>\n    <string>15.2</string>',
    );
    expect(toggledPlist).toContain('<key>CFBundleVersion</key>\n    <string>99</string>');
    expect(toggledPlist).toContain(
      '<key>CFBundleShortVersionString</key>\n    <string>3.0.0</string>',
    );
    expect(toggledPlist).toContain(
      `<key>${BUNDLE_SPEC_DIGEST_PLIST_KEY}</key>\n    <string>${toggledDigest}</string>`,
    );
    expect(toggledPlist).not.toContain('<key>CFBundleDisplayName</key>');
    expect(toggledPlist).not.toContain('<key>CFBundleIconFile</key>');
    expect(toggledPlist).not.toContain('<key>CustomNote</key>');
  });

  test('refuses non-.app, system root (including //System and /./System), regular file, and symlink target paths', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stitchkit-macos-bundle-invalid-'));
    try {
      const realTarget = join(dir, 'Real.app');
      const linkTarget = join(dir, 'Link.app');
      const fileTarget = join(dir, 'RegularFile.app');
      await mkdir(realTarget, { recursive: true });
      await symlink(realTarget, linkTarget);
      await writeFile(fileTarget, 'not-a-directory', 'utf8');

      for (const badPath of [
        'relative/Example.app',
        join(dir, 'NotAnApp'),
        '/.app',
        '/System/Library/CoreServices/Fake.app',
        '//System/Library/CoreServices/Fake.app',
        '/./System/Library/CoreServices/Fake.app',
        `${dir}/../System/Fake.app`,
        '/Library/Apple/Fake.app',
        '/usr/local/Fake.app',
        '/bin/Fake.app',
        '/sbin/Fake.app',
        linkTarget,
        fileTarget,
      ]) {
        await expect(
          ensureSignedBundle({
            bundlePath: badPath,
            bundleIdentifier: 'com.example.daemon',
            bundleName: 'Example',
            executableName: 'example-launcher',
            launcher: { targetExecutable: '/usr/bin/true' },
            signingIdentity: VALID_DEV_ID,
          }),
        ).rejects.toMatchObject({ code: 'INVALID_PATH' });
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('installs fresh bundle, skips rebuild when current, and rebuilds on config drift or force: true', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stitchkit-macos-bundle-idempotent-'));
    try {
      const bundlePath = join(dir, 'Example.app');
      let compileCount = 0;
      let swapCount = 0;
      const registered: string[] = [];
      const forgotten: string[] = [];
      let currentHash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

      const runner: MacosCommandRunner = {
        async runCommand(exe, args) {
          if (exe === CLANG_PATH) {
            compileCount += 1;
            const outPath = args[args.indexOf('-o') + 1] ?? '';
            await writeFile(outPath, `binary-${compileCount}`, 'utf8');
            return { exitCode: 0, stdout: '', stderr: '' };
          }
          if (exe === CODESIGN_PATH && args[0] === '--force') {
            return { exitCode: 0, stdout: '', stderr: '' };
          }
          if (exe === CODESIGN_PATH && args[0] === '--verify') {
            return { exitCode: 0, stdout: '', stderr: '' };
          }
          if (exe === CODESIGN_PATH && args[0] === '-dvvv') {
            return {
              exitCode: 0,
              stdout: '',
              stderr: codesignDvvvStderr('com.example.daemon', currentHash),
            };
          }
          return { exitCode: 1, stdout: '', stderr: `unexpected ${exe} ${args.join(' ')}` };
        },
      };

      const adapter: MacosBundleHostAdapter = {
        runner,
        async swapDirectories(fromDir, toDir) {
          swapCount += 1;
          await swapTwoDirs(fromDir, toDir);
        },
        async readPlist(plistPath) {
          const text = await readFile(plistPath, 'utf8').catch(() => null);
          return text === null ? null : parseDigestFromInfoPlistXml(text);
        },
        lintPlist: noopAsync,
        async registerBundle(appPath) {
          registered.push(appPath);
        },
        async forgetRegistration(appPath) {
          forgotten.push(appPath);
        },
      };

      const baseOpts: EnsureSignedBundleOptions = {
        bundlePath,
        bundleIdentifier: 'com.example.daemon',
        bundleName: 'Example Daemon',
        executableName: 'example-launcher',
        launcher: { targetExecutable: '/Users/example-user/bin/daemon', fixedArgs: ['--v1'] },
        signingIdentity: VALID_DEV_ID,
        adapter,
      };

      // 1. Fresh install
      const first = await ensureSignedBundle(baseOpts);
      expect(first.state).toBe('installed');
      expect(first.signature.cdHash).toBe(currentHash);
      expect(compileCount).toBe(1);
      expect(swapCount).toBe(0);
      expect(registered).toEqual([bundlePath]);
      expect(forgotten).toHaveLength(1);
      expect(forgotten[0]).toContain('.install.noindex');
      expect(await readdir(dir)).toEqual(['Example.app']);

      // 2. Idempotent second call -> state: 'current' with zero rebuilds
      const second = await ensureSignedBundle(baseOpts);
      expect(second.state).toBe('current');
      expect(compileCount).toBe(1);
      expect(swapCount).toBe(0);

      // 3. Config drift triggers rebuild + atomic swapDirectories
      currentHash = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
      const third = await ensureSignedBundle({
        ...baseOpts,
        launcher: { targetExecutable: '/Users/example-user/bin/daemon', fixedArgs: ['--v2'] },
      });
      expect(third.state).toBe('installed');
      expect(third.signature.cdHash).toBe(currentHash);
      expect(compileCount).toBe(2);
      expect(swapCount).toBe(1);

      // 4. force: true rebuilds even with unchanged spec
      const fourth = await ensureSignedBundle({
        ...baseOpts,
        launcher: { targetExecutable: '/Users/example-user/bin/daemon', fixedArgs: ['--v2'] },
        force: true,
      });
      expect(fourth.state).toBe('installed');
      expect(compileCount).toBe(3);
      expect(swapCount).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('aborts BEFORE swap when staged pre-verification fails and leaves existing bundle untouched', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stitchkit-macos-bundle-preswap-'));
    try {
      const bundlePath = join(dir, 'Example.app');
      await mkdir(join(bundlePath, 'Contents', 'MacOS'), { recursive: true });
      await writeFile(join(bundlePath, 'Contents', 'marker.txt'), 'previous-v1', 'utf8');
      let swapCalls = 0;

      const runner: MacosCommandRunner = {
        async runCommand(exe, args) {
          if (exe === CLANG_PATH) {
            await writeFile(args[args.indexOf('-o') + 1] ?? '', 'new-bin', 'utf8');
            return { exitCode: 0, stdout: '', stderr: '' };
          }
          if (exe === CODESIGN_PATH && args[0] === '--force') {
            return { exitCode: 0, stdout: '', stderr: '' };
          }
          if (exe === CODESIGN_PATH && args[0] === '--verify') {
            return {
              exitCode: 1,
              stdout: '',
              stderr: 'sealed resource is missing or invalid',
            };
          }
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      };

      await expect(
        ensureSignedBundle({
          bundlePath,
          bundleIdentifier: 'com.example.daemon',
          bundleName: 'Example',
          executableName: 'example-launcher',
          launcher: { targetExecutable: '/Users/example-user/bin/daemon' },
          signingIdentity: VALID_DEV_ID,
          adapter: {
            runner,
            async swapDirectories() {
              swapCalls += 1;
            },
            async readPlist() {
              return null;
            },
            lintPlist: noopAsync,
            registerBundle: noopAsync,
            forgetRegistration: noopAsync,
          },
        }),
      ).rejects.toMatchObject({ rolledBack: false });

      expect(swapCalls).toBe(0);
      expect(await readFile(join(bundlePath, 'Contents', 'marker.txt'), 'utf8')).toBe(
        'previous-v1',
      );
      expect(await readdir(dir)).toEqual(['Example.app']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('rolls back on post-swap verification failure and preserves stagingDir when rollback itself fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stitchkit-macos-bundle-rollback-'));
    try {
      const bundlePath = join(dir, 'Example.app');
      await mkdir(join(bundlePath, 'Contents', 'MacOS'), { recursive: true });
      await writeFile(join(bundlePath, 'Contents', 'marker.txt'), 'known-good-v1', 'utf8');

      // Case A: post-swap verification fails (CDHash mismatch) -> automatic rollback restores known-good-v1
      let verifyStageCount = 0;
      const postFailRunner: MacosCommandRunner = {
        async runCommand(exe, args) {
          if (exe === CLANG_PATH) {
            await writeFile(args[args.indexOf('-o') + 1] ?? '', 'candidate-v2', 'utf8');
            return { exitCode: 0, stdout: '', stderr: '' };
          }
          if (exe === CODESIGN_PATH && args[0] === '--force') {
            return { exitCode: 0, stdout: '', stderr: '' };
          }
          if (exe === CODESIGN_PATH && args[0] === '--verify') {
            return { exitCode: 0, stdout: '', stderr: '' };
          }
          if (exe === CODESIGN_PATH && args[0] === '-dvvv') {
            verifyStageCount += 1;
            const hash =
              verifyStageCount === 1
                ? '1111111111111111111111111111111111111111'
                : '2222222222222222222222222222222222222222';
            return {
              exitCode: 0,
              stdout: '',
              stderr: codesignDvvvStderr('com.example.daemon', hash),
            };
          }
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      };

      await expect(
        ensureSignedBundle({
          bundlePath,
          bundleIdentifier: 'com.example.daemon',
          bundleName: 'Example',
          executableName: 'example-launcher',
          launcher: { targetExecutable: '/Users/example-user/bin/daemon' },
          signingIdentity: VALID_DEV_ID,
          adapter: {
            runner: postFailRunner,
            swapDirectories: swapTwoDirs,
            async readPlist() {
              return null;
            },
            lintPlist: noopAsync,
            registerBundle: noopAsync,
            forgetRegistration: noopAsync,
          },
        }),
      ).rejects.toMatchObject({ code: 'VERIFICATION_FAILED', rolledBack: true });

      expect(await readFile(join(bundlePath, 'Contents', 'marker.txt'), 'utf8')).toBe(
        'known-good-v1',
      );
      expect(await readdir(dir)).toEqual(['Example.app']);

      // Case B: double failure (afterSwapVerify throws AND rollback swap throws)
      // MUST NOT delete stagingDir and MUST report preservedPreviousBundlePath!
      let swapAttempt = 0;
      const okRunner: MacosCommandRunner = {
        async runCommand(exe, args) {
          if (exe === CLANG_PATH) {
            await writeFile(args[args.indexOf('-o') + 1] ?? '', 'candidate-v3', 'utf8');
            return { exitCode: 0, stdout: '', stderr: '' };
          }
          if (exe === CODESIGN_PATH && args[0] === '-dvvv') {
            return {
              exitCode: 0,
              stdout: '',
              stderr: codesignDvvvStderr(
                'com.example.daemon',
                '3333333333333333333333333333333333333333',
              ),
            };
          }
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      };

      let caught: unknown;
      try {
        await ensureSignedBundle({
          bundlePath,
          bundleIdentifier: 'com.example.daemon',
          bundleName: 'Example',
          executableName: 'example-launcher',
          launcher: { targetExecutable: '/Users/example-user/bin/daemon' },
          signingIdentity: VALID_DEV_ID,
          async afterSwapVerify() {
            throw new Error('health check failed after swap');
          },
          adapter: {
            runner: okRunner,
            async swapDirectories(fromDir, toDir) {
              swapAttempt += 1;
              if (swapAttempt === 1) {
                await swapTwoDirs(fromDir, toDir);
                return;
              }
              throw new Error('EIO during rollback swap');
            },
            async readPlist() {
              return null;
            },
            lintPlist: noopAsync,
            registerBundle: noopAsync,
            forgetRegistration: noopAsync,
          },
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(MacosBundleInstallError);
      const installErr = caught instanceof MacosBundleInstallError ? caught : null;
      expect(installErr?.code).toBe('ROLLBACK_FAILED');
      expect(installErr?.rolledBack).toBe(false);
      expect(installErr?.preservedPreviousBundlePath).toBeDefined();
      const preservedPath = installErr?.preservedPreviousBundlePath ?? '';
      expect((await stat(preservedPath)).isDirectory()).toBe(true);
      expect(await readFile(join(preservedPath, 'Contents', 'marker.txt'), 'utf8')).toBe(
        'known-good-v1',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('validates signingIdentity BEFORE current short-circuit, hashes entitlements/arch/identity drift, handles SWAP_FAILED and fresh-install rollback', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stitchkit-macos-bundle-edge-'));
    try {
      const bundlePath = join(dir, 'Example.app');
      const entPath = join(dir, 'entitlements.plist');
      await writeFile(
        entPath,
        '<plist version="1.0"><dict><key>v</key><string>1</string></dict></plist>',
        'utf8',
      );

      let compileCount = 0;
      const hash = 'cccccccccccccccccccccccccccccccccccccccc';
      const runner: MacosCommandRunner = {
        async runCommand(exe, args) {
          if (exe === CLANG_PATH) {
            compileCount += 1;
            await writeFile(args[args.indexOf('-o') + 1] ?? '', `bin-${compileCount}`, 'utf8');
            return { exitCode: 0, stdout: '', stderr: '' };
          }
          if (exe === CODESIGN_PATH && args[0] === '-dvvv') {
            return {
              exitCode: 0,
              stdout: '',
              stderr: codesignDvvvStderr('com.example.daemon', hash),
            };
          }
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      };
      const baseAdapter: MacosBundleHostAdapter = {
        runner,
        swapDirectories: swapTwoDirs,
        async readPlist(plistPath) {
          const text = await readFile(plistPath, 'utf8').catch(() => null);
          return text === null ? null : parseDigestFromInfoPlistXml(text);
        },
        lintPlist: noopAsync,
        registerBundle: noopAsync,
        forgetRegistration: noopAsync,
      };
      const baseOpts: EnsureSignedBundleOptions = {
        bundlePath,
        bundleIdentifier: 'com.example.daemon',
        bundleName: 'Example',
        executableName: 'example-launcher',
        launcher: { targetExecutable: '/Users/example-user/bin/daemon' },
        signingIdentity: VALID_DEV_ID,
        entitlementsPath: entPath,
        arch: 'arm64',
        adapter: baseAdapter,
      };

      // Fresh install rollback cleans up newly moved bundlePath on post-swap failure
      await expect(
        ensureSignedBundle({
          ...baseOpts,
          async afterSwapVerify() {
            throw new Error('fresh post-swap failure');
          },
        }),
      ).rejects.toMatchObject({ rolledBack: true });
      await expect(stat(bundlePath)).rejects.toThrow();

      // Successful fresh install
      const installed = await ensureSignedBundle(baseOpts);
      expect(installed.state).toBe('installed');

      // Forbidden signingIdentity ('-' or null) MUST fail even when existing bundle is current!
      await expect(
        ensureSignedBundle({ ...baseOpts, signingIdentity: '-' }),
      ).rejects.toMatchObject({ code: 'INVALID_IDENTITY' });
      await expect(
        ensureSignedBundle({ ...baseOpts, signingIdentity: null }),
      ).rejects.toMatchObject({ code: 'INVALID_IDENTITY' });

      // Drift in entitlements file content, arch, or signingIdentity triggers rebuild
      await writeFile(
        entPath,
        '<plist version="1.0"><dict><key>v</key><string>2</string></dict></plist>',
        'utf8',
      );
      const entDrifted = await ensureSignedBundle(baseOpts);
      expect(entDrifted.state).toBe('installed');

      const archDrifted = await ensureSignedBundle({ ...baseOpts, arch: 'x86_64' });
      expect(archDrifted.state).toBe('installed');

      // SWAP_FAILED classification when swapDirectories throws directly
      await expect(
        ensureSignedBundle({
          ...baseOpts,
          force: true,
          adapter: {
            ...baseAdapter,
            async swapDirectories() {
              throw new Error('EXDEV');
            },
          },
        }),
      ).rejects.toMatchObject({ code: 'SWAP_FAILED', rolledBack: false });

      // Trailing slash on a symlinked .app target and mixed-case forbidden prefix are refused
      const linkPath = join(dir, 'Link.app');
      await (await import('node:fs/promises')).symlink(bundlePath, linkPath);
      await expect(
        ensureSignedBundle({ ...baseOpts, bundlePath: `${linkPath}/` }),
      ).rejects.toMatchObject({ code: 'INVALID_PATH' });
      await expect(
        ensureSignedBundle({ ...baseOpts, bundlePath: '/SYSTEM/Library/Example.app' }),
      ).rejects.toMatchObject({ code: 'INVALID_PATH' });

      // Invalid entitlementsPath is rejected with INVALID_PATH BEFORE reading, and non-regular files fail via readRegularFile
      for (const badEntitlements of [
        'relative/entitlements.plist',
        '/tmp/../etc/entitlements.plist',
        '/tmp/ent\n.plist',
        '/tmp/ent\0.plist',
      ]) {
        await expect(
          ensureSignedBundle({ ...baseOpts, entitlementsPath: badEntitlements }),
        ).rejects.toMatchObject({ code: 'INVALID_PATH' });
      }
      await expect(
        ensureSignedBundle({ ...baseOpts, entitlementsPath: '/dev/null' }),
      ).rejects.toMatchObject({ code: 'STAGING_FAILED' });
      await expect(
        ensureSignedBundle({ ...baseOpts, entitlementsPath: dir }),
      ).rejects.toMatchObject({ code: 'STAGING_FAILED' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('the protected macOS system roots', () => {
  test('/Applications is protected, except as the install target of a bundle', () => {
    expect(isProtectedMacosSystemPath('/Applications/Example.app')).toBe(true);
    expect(isProtectedMacosSystemPath('/applications/Example.app')).toBe(true);
    expect(
      isProtectedMacosSystemPath('/Applications/Example.app', {
        applications: 'install-target',
      }),
    ).toBe(false);
  });

  test('the other system roots stay protected for a bundle install target', () => {
    for (const path of [
      '/System/Library/Fake.app',
      '/Library/Apple/Fake.app',
      '/usr/local/Fake.app',
      '/bin/Fake.app',
      '/sbin/Fake.app',
    ]) {
      expect(isProtectedMacosSystemPath(path, { applications: 'install-target' }), path).toBe(
        true,
      );
    }
    expect(isProtectedMacosSystemPath('/Users/someone/Applications/Fake.app')).toBe(false);
  });
});
