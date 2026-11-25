import { describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  rmSync,
} from 'node:fs';
import { chmod, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
  createDefaultSystemdHostAdapter,
  installAndStartSystemdUnit,
  reloadSystemdUnit,
  renderSystemdServiceUnit,
  type SystemdHostAdapter,
} from '../src/entrypoints/service-host';

const SYSTEMCTL = '/usr/bin/systemctl';
const UNIT = 'example-links.service';

/** `[Install]` of a unit that hangs off `targets`. */
const unitFor = (description: string, targets: string[]) =>
  renderSystemdServiceUnit({
    description,
    scope: 'system',
    execStart: ['/opt/example/agent'],
    wantedBy: targets,
  });

function runSystemctl(root: string, args: readonly string[]) {
  const result = Bun.spawnSync([SYSTEMCTL, `--root=${root}`, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

/**
 * A host whose enablement is real: `enable`, `disable`, `reenable` and `is-enabled` run the
 * installed systemctl against an offline image at `root`, so links are what systemd makes.
 * The manager is the fake part: it loads the unit from where it was written and every
 * candidate `restart` fails, which makes the apply roll back.
 */
function offlineHost(root: string, unitPath: string): SystemdHostAdapter {
  const links = new Set(['enable', 'disable', 'reenable', 'is-enabled']);
  // The files are the real default adapter's: written, read and inspected on disk.
  return {
    ...createDefaultSystemdHostAdapter(),
    async runCommand(_executable, args) {
      if (args.includes('--property=UnitPath'))
        return { exitCode: 0, stdout: `${join(root, 'etc/systemd/system')}\n`, stderr: '' };
      const verb = args.find((arg) => !arg.startsWith('-'));
      if (verb !== undefined && links.has(verb)) return runSystemctl(root, args);
      if (verb === 'show') {
        const state = runSystemctl(root, ['is-enabled', '--', UNIT]).stdout.trim();
        return {
          exitCode: 0,
          stdout: `LoadState=loaded\nFragmentPath=${unitPath}\nDropInPaths=\nActiveState=inactive\nSubState=dead\nMainPID=0\nUnitFileState=${state}\n`,
          stderr: '',
        };
      }
      if (verb === 'restart') return { exitCode: 1, stdout: '', stderr: 'candidate failed' };
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    now: () => 0,
    sleep: async () => undefined,
  };
}

/** Every symlink under the image, as `<path in image> -> <target>`. */
function linksIn(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink())
        found.push(`${relative(root, path)} -> ${readlinkSync(path)}`);
      else if (entry.isDirectory()) walk(path);
    }
  };
  walk(root);
  return found.sort();
}

describe('service-host systemd: rollback puts back the enable links, checked on disk', () => {
  test('an enabled unit whose candidate names another target keeps only its own link after rollback', async () => {
    if (!existsSync(SYSTEMCTL)) return;
    const root = mkdtempSync(join(tmpdir(), 'stitchkit-systemd-links-'));
    try {
      const unitDir = join(root, 'etc/systemd/system');
      mkdirSync(unitDir, { recursive: true });
      const unitPath = join(unitDir, UNIT);
      await writeFile(unitPath, unitFor('v1', ['multi-user.target']));
      expect(runSystemctl(root, ['enable', '--', UNIT]).exitCode).toBe(0);
      const before = linksIn(root);
      expect(before).toEqual([
        `etc/systemd/system/multi-user.target.wants/${UNIT} -> /etc/systemd/system/${UNIT}`,
      ]);

      await expect(
        installAndStartSystemdUnit({
          unitName: UNIT,
          unitPath,
          content: unitFor('v2', ['default.target']),
          scope: 'system',
          adapter: offlineHost(root, unitPath),
        }),
      ).rejects.toMatchObject({ code: 'COMMAND_FAILED', rolledBack: true });
      expect(await readFile(unitPath, 'utf8')).toBe(unitFor('v1', ['multi-user.target']));
      expect(linksIn(root)).toEqual(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a disabled unit loses the link enable made, and a link that does not go is not rolledBack', async () => {
    if (!existsSync(SYSTEMCTL)) return;
    const root = mkdtempSync(join(tmpdir(), 'stitchkit-systemd-links-'));
    try {
      const unitDir = join(root, 'etc/systemd/system');
      mkdirSync(unitDir, { recursive: true });
      const unitPath = join(unitDir, UNIT);
      await writeFile(unitPath, unitFor('v1', ['multi-user.target']));
      await expect(
        installAndStartSystemdUnit({
          unitName: UNIT,
          unitPath,
          content: unitFor('v2', ['default.target']),
          scope: 'system',
          adapter: offlineHost(root, unitPath),
        }),
      ).rejects.toMatchObject({ code: 'COMMAND_FAILED', rolledBack: true });
      expect(linksIn(root)).toEqual([]);

      // A host whose removal answers and removes nothing: the check reads the links again.
      const host = offlineHost(root, unitPath);
      const lying: SystemdHostAdapter = { ...host, removeFile: async () => undefined };
      let caught: unknown;
      try {
        await installAndStartSystemdUnit({
          unitName: UNIT,
          unitPath,
          content: unitFor('v2', ['default.target']),
          scope: 'system',
          adapter: lying,
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({
        code: 'COMMAND_FAILED',
        rolledBack: false,
        message: expect.stringContaining(
          `the enable links of ${UNIT} differ from before the apply`,
        ),
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('service-host systemd: rollback compares the enable links, not the [Install] text', () => {
  test('links that no longer match [Install] are what is put back: the link enable added goes', async () => {
    if (!existsSync(SYSTEMCTL)) return;
    const root = mkdtempSync(join(tmpdir(), 'stitchkit-systemd-stale-'));
    try {
      const unitDir = join(root, 'etc/systemd/system');
      mkdirSync(unitDir, { recursive: true });
      const unitPath = join(unitDir, UNIT);
      await writeFile(unitPath, unitFor('v1', ['multi-user.target']));
      expect(runSystemctl(root, ['enable', '--', UNIT]).exitCode).toBe(0);
      // The operator edits [Install] and does not reenable: the links stay as they were.
      const edited = unitFor('v1', ['default.target']);
      await writeFile(unitPath, edited);
      const before = linksIn(root);
      await expect(
        installAndStartSystemdUnit({
          unitName: UNIT,
          unitPath,
          content: unitFor('v2', ['default.target']),
          scope: 'system',
          adapter: offlineHost(root, unitPath),
        }),
      ).rejects.toMatchObject({ code: 'COMMAND_FAILED', rolledBack: true });
      expect(await readFile(unitPath, 'utf8')).toBe(edited);
      expect(linksIn(root)).toEqual(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('an enable that links and then answers an error is rolled back too', async () => {
    if (!existsSync(SYSTEMCTL)) return;
    const root = mkdtempSync(join(tmpdir(), 'stitchkit-systemd-late-'));
    try {
      const unitDir = join(root, 'etc/systemd/system');
      mkdirSync(unitDir, { recursive: true });
      const unitPath = join(unitDir, UNIT);
      await writeFile(unitPath, unitFor('v1', ['multi-user.target']));
      const host = offlineHost(root, unitPath);
      // The manager made the links, then the bus timed out.
      const timedOut: SystemdHostAdapter = {
        ...host,
        async runCommand(executable, args) {
          const result = await host.runCommand(executable, args);
          if (args.includes('enable'))
            return { exitCode: 1, stdout: '', stderr: 'Connection timed out' };
          return result;
        },
      };
      await expect(
        installAndStartSystemdUnit({
          unitName: UNIT,
          unitPath,
          content: unitFor('v2', ['multi-user.target']),
          scope: 'system',
          adapter: timedOut,
        }),
      ).rejects.toMatchObject({ code: 'COMMAND_FAILED', rolledBack: true });
      expect(linksIn(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('service-host systemd: rollback undoes what enable did to an Also= unit', () => {
  test('a candidate whose [Install] names Also= loses the companion links enable made too', async () => {
    if (!existsSync(SYSTEMCTL)) return;
    const root = mkdtempSync(join(tmpdir(), 'stitchkit-systemd-also-'));
    try {
      const unitDir = join(root, 'etc/systemd/system');
      mkdirSync(unitDir, { recursive: true });
      const unitPath = join(unitDir, UNIT);
      const helper = 'example-links-helper.service';
      await writeFile(join(unitDir, helper), unitFor('helper', ['multi-user.target']));
      await writeFile(unitPath, unitFor('v1', ['multi-user.target']));
      const candidate = unitFor('v2', ['multi-user.target']).replace(
        '[Install]\n',
        `[Install]\nAlso=${helper}\n`,
      );
      expect(candidate).toContain(`Also=${helper}`);
      await expect(
        installAndStartSystemdUnit({
          unitName: UNIT,
          unitPath,
          content: candidate,
          scope: 'system',
          adapter: offlineHost(root, unitPath),
        }),
      ).rejects.toMatchObject({ code: 'COMMAND_FAILED', rolledBack: true });
      expect(linksIn(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('service-host systemd: rollback puts back the unit file as it stood', () => {
  test('a rollback restores the mode the unit file had, not the candidate mode', async () => {
    if (!existsSync(SYSTEMCTL)) return;
    const root = mkdtempSync(join(tmpdir(), 'stitchkit-systemd-mode-'));
    try {
      const unitDir = join(root, 'etc/systemd/system');
      mkdirSync(unitDir, { recursive: true });
      const unitPath = join(unitDir, UNIT);
      const previous = unitFor('v1', ['multi-user.target']);
      await writeFile(unitPath, previous);
      await chmod(unitPath, 0o600);
      await expect(
        reloadSystemdUnit({
          unitName: UNIT,
          unitPath,
          content: unitFor('v2', ['multi-user.target']),
          scope: 'system',
          adapter: offlineHost(root, unitPath),
        }),
      ).rejects.toMatchObject({ code: 'COMMAND_FAILED', rolledBack: true });
      expect(await readFile(unitPath, 'utf8')).toBe(previous);
      expect((await stat(unitPath)).mode & 0o7777).toBe(0o600);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a symbolic link at unitPath is refused before anything is written, and its target is untouched', async () => {
    if (!existsSync(SYSTEMCTL)) return;
    const root = mkdtempSync(join(tmpdir(), 'stitchkit-systemd-link-'));
    try {
      const unitDir = join(root, 'etc/systemd/system');
      mkdirSync(unitDir, { recursive: true });
      mkdirSync(join(root, 'opt'));
      const target = join(root, 'opt', UNIT);
      const unitPath = join(unitDir, UNIT);
      const theirs = unitFor('theirs', ['multi-user.target']);
      await writeFile(target, theirs);
      await symlink(target, unitPath);
      const host = offlineHost(root, unitPath);
      const verbs: string[] = [];
      const recording: SystemdHostAdapter = {
        ...host,
        async runCommand(executable, args) {
          verbs.push(args.find((arg) => !arg.startsWith('-')) ?? '');
          return host.runCommand(executable, args);
        },
      };
      await expect(
        installAndStartSystemdUnit({
          unitName: UNIT,
          unitPath,
          content: unitFor('ours', ['multi-user.target']),
          scope: 'system',
          adapter: recording,
        }),
      ).rejects.toMatchObject({
        code: 'FOREIGN_FRAGMENT',
        rolledBack: false,
        message: expect.stringContaining(`a symbolic link to ${target}`),
      });
      expect(readlinkSync(unitPath)).toBe(target);
      expect(await readFile(target, 'utf8')).toBe(theirs);
      expect(verbs).not.toContain('daemon-reload');
      expect(verbs).not.toContain('enable');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
