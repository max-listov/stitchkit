import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertValidIcnsBytes,
  compileMacosLauncher,
  generateAppIconIcns,
  inspectResponsibleProcess,
  LAUNCHER_EXIT_NOT_LAUNCHD,
  swapDirectoriesDarwin,
} from '../src/entrypoints/service-host/macos';
import { runNativeCommand } from '../src/process/command';
import { lintLaunchdPlist, readLaunchdPlist } from '../src/service-host/launchd-plist';
import { renderLaunchdPlist } from '../src/service-host/launchd-render';
import { reapAfterEachTest, trackGroupLeader } from './support/process-reaper';

reapAfterEachTest();

describe.skipIf(process.platform !== 'darwin')(
  'service-host/macos live Darwin integration',
  () => {
    test('compiled C11 launcher exits 78 when ppid != 1 and spawns target ignoring extra argv when requireLaunchdParent: false', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'stitchkit-darwin-launcher-'));
      try {
        const strictBin = join(dir, 'strict-launcher');
        await compileMacosLauncher({
          config: {
            targetExecutable: '/bin/echo',
            fixedArgs: ['fixed-only'],
            requireLaunchdParent: true,
          },
          outputPath: strictBin,
        });

        const denied = await runNativeCommand({
          executable: strictBin,
          args: ['ignored'],
          timeoutMs: 10_000,
          capture: true,
          maxOutputBytes: 64 * 1024,
          onLeaderStarted: trackGroupLeader,
        });
        expect(denied.exitCode).toBe(LAUNCHER_EXIT_NOT_LAUNCHD);

        const permissiveBin = join(dir, 'permissive-launcher');
        await compileMacosLauncher({
          config: {
            targetExecutable: '/bin/echo',
            fixedArgs: ['fixed-only'],
            forwardArgv: false,
            requireLaunchdParent: false,
          },
          outputPath: permissiveBin,
        });

        const allowed = await runNativeCommand({
          executable: permissiveBin,
          args: ['injected-arg'],
          timeoutMs: 10_000,
          capture: true,
          maxOutputBytes: 64 * 1024,
          onLeaderStarted: trackGroupLeader,
        });
        expect(allowed.exitCode).toBe(0);
        expect(new TextDecoder().decode(allowed.stdout).trim()).toBe('fixed-only');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    test('plutil lints and reads a rendered LaunchAgent plist on real macOS', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'stitchkit-darwin-plist-'));
      try {
        const plistPath = join(dir, 'com.example.test.plist');
        const xml = renderLaunchdPlist({
          label: 'com.example.test',
          associatedBundleIdentifiers: 'com.example.app',
          programArguments: ['/usr/bin/true'],
          limitLoadToSessionType: 'Aqua',
        });
        await lintLaunchdPlist({ content: xml });
        await writeFile(plistPath, xml, 'utf8');
        await lintLaunchdPlist({ path: plistPath });
        const parsed = await readLaunchdPlist({ path: plistPath });
        expect(parsed?.Label).toBe('com.example.test');
        expect(parsed?.AssociatedBundleIdentifiers).toBe('com.example.app');
        expect(parsed?.LimitLoadToSessionType).toBe('Aqua');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    test('swapDirectoriesDarwin atomically exchanges two directories via renameatx_np RENAME_SWAP', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'stitchkit-darwin-swap-'));
      try {
        const left = join(dir, 'Left.app');
        const right = join(dir, 'Right.app');
        await mkdir(left, { recursive: true });
        await mkdir(right, { recursive: true });
        await writeFile(join(left, 'id.txt'), 'left', 'utf8');
        await writeFile(join(right, 'id.txt'), 'right', 'utf8');

        await swapDirectoriesDarwin(left, right);
        expect(await readFile(join(left, 'id.txt'), 'utf8')).toBe('right');
        expect(await readFile(join(right, 'id.txt'), 'utf8')).toBe('left');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    test('inspectResponsibleProcess observes the current process on Darwin', async () => {
      const result = await inspectResponsibleProcess({ pid: process.pid });
      expect(result.status).toBe('observed');
      expect(result.responsiblePid).toBeGreaterThan(0);
      expect(result.responsiblePath?.startsWith('/')).toBe(true);
    });

    test('generateAppIconIcns builds a valid AppIcon.icns from SVG using qlmanage, sips, and iconutil', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'stitchkit-darwin-icon-'));
      try {
        const icnsPath = join(dir, 'AppIcon.icns');
        const built = await generateAppIconIcns({
          source: {
            kind: 'svg',
            svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="#2563eb"/></svg>',
            backgroundColor: '#0f172a',
          },
          outputPath: icnsPath,
        });
        expect(built.byteLength).toBeGreaterThan(8);
        assertValidIcnsBytes(new Uint8Array(await readFile(icnsPath)));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }, 30_000);
  },
);
