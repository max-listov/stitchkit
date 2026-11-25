import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkSystemdUnit,
  createDefaultLaunchdHostAdapter,
  createDefaultProcessIdentityAdapter,
  createDefaultSystemdHostAdapter,
  type LaunchdHostAdapter,
  reloadLaunchdJob,
  reloadSystemdUnit,
  renderLaunchdPlist,
  renderSystemdServiceUnit,
  type SystemdHostAdapter,
  verifySupervisedProcess,
} from '../src/entrypoints/service-host';

/**
 * A manager names the file it loaded with the links in its directories resolved: launchd prints
 * `/private/tmp/…` for a plist under `/tmp` on macOS. Here `alias` links to `real`, and each
 * fake manager reports the `real` spelling of a path given through `alias`.
 */
let root: string;
let real: string;
let alias: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stitchkit-linked-dir-'));
  real = join(root, 'real');
  alias = join(root, 'alias');
  mkdirSync(real);
  symlinkSync(real, alias);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('service-host: a path through a linked directory is the place the manager names', () => {
  const label = 'com.example.daemon';
  const content = renderLaunchdPlist({ label, programArguments: ['/opt/ours/daemon'] });

  /** The real files of the default adapter, under a fake launchd that prints `printed`. */
  function launchdPrinting(printed: string): LaunchdHostAdapter {
    let loaded = true;
    let pid = 42;
    return {
      ...createDefaultLaunchdHostAdapter(),
      async runCommand(_executable, args) {
        if (args[0] === 'print') {
          if (!loaded) return { exitCode: 113, stdout: '', stderr: 'Could not find service' };
          return {
            exitCode: 0,
            stdout: `gui/501/${label} = {\n\tpath = ${printed}\n\tstate = running\n\tprogram = /opt/ours/daemon\n\tpid = ${pid}\n}\n`,
            stderr: '',
          };
        }
        if (args[0] === 'bootout') loaded = false;
        if (args[0] === 'bootstrap') {
          loaded = true;
          pid = 77;
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      now: () => 0,
      sleep: async () => undefined,
    };
  }

  test('reloadLaunchdJob reloads its own job when launchd prints the resolved plist path', async () => {
    writeFileSync(join(real, `${label}.plist`), content);
    const result = await reloadLaunchdJob({
      label,
      uid: 501,
      plistPath: join(alias, `${label}.plist`),
      content,
      validatePlist: 'none',
      stabilityMs: 0,
      adapter: launchdPrinting(join(real, `${label}.plist`)),
    });
    expect(result.pid).toBe(77);
    // Negative control: a job loaded from another directory is still not ours.
    mkdirSync(join(root, 'other'));
    await expect(
      reloadLaunchdJob({
        label,
        uid: 501,
        plistPath: join(alias, `${label}.plist`),
        content,
        validatePlist: 'none',
        stabilityMs: 0,
        adapter: launchdPrinting(join(root, 'other', `${label}.plist`)),
      }),
    ).rejects.toMatchObject({ code: 'FOREIGN_FRAGMENT', rolledBack: false });
  });

  test('a systemd unit whose FragmentPath is the resolved spelling of unitPath is ours', async () => {
    const unitName = 'example-linked.service';
    const unit = renderSystemdServiceUnit({
      description: 'Example',
      scope: 'system',
      execStart: ['/opt/example/agent'],
    });
    writeFileSync(join(real, unitName), unit);
    const unitPath = join(alias, unitName);
    const fragmentPath = join(real, unitName);
    const adapter: SystemdHostAdapter = {
      ...createDefaultSystemdHostAdapter(),
      async runCommand(_executable, args) {
        if (args.includes('--property=UnitPath'))
          return { exitCode: 0, stdout: `${alias}\n`, stderr: '' };
        if (args.includes('--property=MainPID'))
          return { exitCode: 0, stdout: '4242\n', stderr: '' };
        if (args.includes('is-active')) return { exitCode: 0, stdout: 'active\n', stderr: '' };
        if (args.includes('show'))
          return {
            exitCode: 0,
            stdout: `LoadState=loaded\nFragmentPath=${fragmentPath}\nDropInPaths=\nActiveState=active\nSubState=running\nMainPID=4242\nUnitFileState=enabled\n`,
            stderr: '',
          };
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      now: () => 0,
      sleep: async () => undefined,
    };
    const check = await checkSystemdUnit({
      unitName,
      unitPath,
      expectedContent: unit,
      scope: 'system',
      adapter,
    });
    expect(check).toMatchObject({ status: 'matches', fragmentPath, fragmentIsUnitPath: true });
    const applied = await reloadSystemdUnit({
      unitName,
      unitPath,
      content: unit,
      scope: 'system',
      stabilityMs: 0,
      adapter,
    });
    expect(applied.mainPid).toBe(4242);
  });

  test('verifySupervisedProcess takes an expectedExe reached through a linked directory', async () => {
    if (platform() !== 'linux') return;
    // This process's executable, named through a link to its directory.
    const binDir = join(process.execPath, '..');
    const linkedBin = join(root, 'bin');
    symlinkSync(binDir, linkedBin);
    const expectedExe = join(linkedBin, process.execPath.slice(binDir.length + 1));
    const verified = await verifySupervisedProcess({
      pid: process.pid,
      expectedExe,
      adapter: createDefaultProcessIdentityAdapter('/proc'),
    });
    expect(verified.status).toBe('verified');
  });
});
