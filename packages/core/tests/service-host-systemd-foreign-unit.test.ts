import { describe, expect, test } from 'bun:test';
import {
  checkSystemdUnit,
  installAndStartSystemdUnit,
  reloadSystemdUnit,
  renderSystemdServiceUnit,
  SystemdUnitError,
} from '../src/entrypoints/service-host';
import {
  createFakeSystemdAdapter,
  linkOnFakeHost,
  NOT_FOUND_SHOW,
  showFor,
} from './support/fake-systemd-host';

const UNIT_NAME = 'example-agent.service';
const UNIT_PATH = '/etc/systemd/system/example-agent.service';
const CONTENT = renderSystemdServiceUnit({
  description: 'Example agent',
  scope: 'system',
  execStart: ['/opt/example/agent'],
});
const OLD_CONTENT = renderSystemdServiceUnit({
  description: 'Example agent v1',
  scope: 'system',
  execStart: ['/opt/example/v1/agent'],
});

function loadedFrom(fragmentPath: string, unitFileState = 'enabled'): string {
  return `LoadState=loaded\nFragmentPath=${fragmentPath}\nDropInPaths=\nActiveState=active\nSubState=running\nMainPID=4242\nUnitFileState=${unitFileState}\n`;
}

/** A host where `systemctl show` answers `show` and every other command succeeds. */
function hostAnswering(show: string) {
  return createFakeSystemdAdapter((_exe, args) => {
    if (args.includes('--property=UnitPath')) {
      return {
        exitCode: 0,
        stdout:
          '/etc/systemd/system /run/systemd/transient /run/systemd/generator /usr/lib/systemd/system\n',
        stderr: '',
      };
    }
    if (args.includes('show')) return { exitCode: 0, stdout: show, stderr: '' };
    return { exitCode: 0, stdout: '', stderr: '' };
  });
}

describe('service-host systemd: a name systemd already loads from another place', () => {
  test('no file at unitPath while the name loads from a vendor, transient or generator unit is fragment-mismatch, not missing', async () => {
    const elsewhere = {
      vendor: loadedFrom('/usr/lib/systemd/system/example-agent.service'),
      transient: loadedFrom('/run/systemd/transient/example-agent.service', 'transient'),
      generator: loadedFrom('/run/systemd/generator/example-agent.service', 'generated'),
      'no unit file': loadedFrom('', 'static'),
    };
    for (const [source, show] of Object.entries(elsewhere)) {
      const { adapter } = hostAnswering(show);
      const result = await checkSystemdUnit({
        unitName: UNIT_NAME,
        unitPath: UNIT_PATH,
        expectedContent: CONTENT,
        scope: 'system',
        adapter,
      });
      expect(result.actualDigest, source).toBeNull();
      expect(result.status, source).toBe('fragment-mismatch');
      expect(result.ok, source).toBe(false);
    }
  });

  test('no file and nothing loaded is missing; our own path still loaded after the file went is missing too', async () => {
    const notFound = hostAnswering(NOT_FOUND_SHOW);
    expect(
      (
        await checkSystemdUnit({
          unitName: UNIT_NAME,
          unitPath: UNIT_PATH,
          expectedContent: CONTENT,
          scope: 'system',
          adapter: notFound.adapter,
        })
      ).status,
    ).toBe('missing');

    // systemd still holds the unit it read from our path before the file was removed:
    // nothing else answers for the name, so writing it is ours to do.
    const staleOwn = hostAnswering(loadedFrom(UNIT_PATH));
    expect(
      (
        await checkSystemdUnit({
          unitName: UNIT_NAME,
          unitPath: UNIT_PATH,
          expectedContent: CONTENT,
          scope: 'system',
          adapter: staleOwn.adapter,
        })
      ).status,
    ).toBe('missing');
  });

  test('installAndStartSystemdUnit refuses a name loaded with no unit file before writing anything', async () => {
    const { adapter, state } = hostAnswering(loadedFrom('', 'static'));
    await expect(
      installAndStartSystemdUnit({
        unitName: UNIT_NAME,
        unitPath: UNIT_PATH,
        content: CONTENT,
        scope: 'system',
        adapter,
      }),
    ).rejects.toMatchObject({ code: 'FOREIGN_FRAGMENT', rolledBack: false });
    expect(state.files.has(UNIT_PATH)).toBe(false);
    expect(state.commands.some((command) => command.args.includes('daemon-reload'))).toBe(
      false,
    );
  });
});

describe('service-host systemd: rollback answers rolledBack only when every step held', () => {
  const WANTS_LINK = `/etc/systemd/system/multi-user.target.wants/${UNIT_NAME}`;

  /**
   * A host whose candidate restart fails; `fail` makes one rollback command fail too. `enable`
   * links the unit into `multi-user.target.wants`, as systemd would.
   */
  function failingRestartHost(options: { unitFileState?: string; fail?: 'stop' }) {
    let restarts = 0;
    return createFakeSystemdAdapter((_exe, args, state) => {
      if (args.includes('enable')) linkOnFakeHost(state, WANTS_LINK, UNIT_PATH);
      if (args.includes('--property=UnitPath')) {
        return { exitCode: 0, stdout: '/etc/systemd/system\n', stderr: '' };
      }
      if (args.includes('restart')) {
        restarts += 1;
        return { exitCode: 1, stdout: '', stderr: `restart ${restarts} failed` };
      }
      if (options.fail !== undefined && args.includes(options.fail)) {
        return { exitCode: 1, stdout: '', stderr: `${options.fail} refused` };
      }
      // The enablement as it was: what a rollback that put it back reads.
      if (args.includes('is-enabled')) {
        return { exitCode: 0, stdout: `${options.unitFileState ?? ''}\n`, stderr: '' };
      }
      if (args.includes('show')) {
        return {
          exitCode: 0,
          stdout: showFor(state, UNIT_PATH, 'inactive', options.unitFileState),
          stderr: '',
        };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });
  }

  function verbsAfterFirstRestart(commands: Array<{ args: readonly string[] }>): string[] {
    const first = commands.findIndex((command) => command.args.includes('restart'));
    return commands
      .slice(first + 1)
      .map((command) => command.args.filter((arg) => !arg.startsWith('--')).join(' '))
      .filter((verb) => !verb.startsWith('show'));
  }

  test('an existing disabled unit enabled by the candidate is disabled again on rollback', async () => {
    const fake = failingRestartHost({ unitFileState: 'disabled' });
    fake.state.files.set(UNIT_PATH, OLD_CONTENT);
    await expect(
      installAndStartSystemdUnit({
        unitName: UNIT_NAME,
        unitPath: UNIT_PATH,
        content: CONTENT,
        scope: 'system',
        adapter: fake.adapter,
      }),
    ).rejects.toMatchObject({ code: 'COMMAND_FAILED', rolledBack: true });
    expect(fake.state.files.get(UNIT_PATH)).toBe(OLD_CONTENT);
    // The link `enable` made is removed and the manager reloaded; `is-enabled` checks it.
    expect(fake.state.links.has(WANTS_LINK)).toBe(false);
    expect(verbsAfterFirstRestart(fake.state.commands)).toEqual([
      'daemon-reload',
      `stop ${UNIT_NAME}`,
      'daemon-reload',
      `is-enabled ${UNIT_NAME}`,
    ]);
  });

  test('an existing enabled unit whose links enable did not change keeps them: rollback removes none and checks it', async () => {
    const fake = failingRestartHost({ unitFileState: 'enabled' });
    fake.state.files.set(UNIT_PATH, OLD_CONTENT);
    linkOnFakeHost(fake.state, WANTS_LINK, UNIT_PATH);
    await expect(
      installAndStartSystemdUnit({
        unitName: UNIT_NAME,
        unitPath: UNIT_PATH,
        content: CONTENT,
        scope: 'system',
        adapter: fake.adapter,
      }),
    ).rejects.toMatchObject({ code: 'COMMAND_FAILED', rolledBack: true });
    expect(fake.state.links.get(WANTS_LINK)).toBe(UNIT_PATH);
    expect(verbsAfterFirstRestart(fake.state.commands)).toEqual([
      'daemon-reload',
      `stop ${UNIT_NAME}`,
      `is-enabled ${UNIT_NAME}`,
    ]);
  });

  test('a fresh install whose rollback stop or link removal fails is not rolledBack', async () => {
    for (const fail of ['stop', 'link'] as const) {
      const fake = failingRestartHost(fail === 'stop' ? { fail } : {});
      if (fail === 'link') {
        const remove = fake.adapter.removeFile;
        fake.adapter.removeFile = async (path) => {
          if (path === WANTS_LINK) throw new Error('link refused');
          await remove(path);
        };
      }
      let caught: unknown;
      try {
        await installAndStartSystemdUnit({
          unitName: UNIT_NAME,
          unitPath: UNIT_PATH,
          content: CONTENT,
          scope: 'system',
          adapter: fake.adapter,
        });
      } catch (error) {
        caught = error;
      }
      expect(caught, fail).toBeInstanceOf(SystemdUnitError);
      if (caught instanceof SystemdUnitError) {
        expect(caught.rolledBack, fail).toBe(false);
        expect(caught.message, fail).toContain('rollback also failed');
        expect(caught.message, fail).toContain(`${fail} refused`);
        expect(fake.state.files.has(UNIT_PATH), fail).toBe(true);
      }
    }
    // Positive control: the same host with no failing step rolls back.
    const clean = failingRestartHost({});
    await expect(
      installAndStartSystemdUnit({
        unitName: UNIT_NAME,
        unitPath: UNIT_PATH,
        content: CONTENT,
        scope: 'system',
        adapter: clean.adapter,
      }),
    ).rejects.toMatchObject({ code: 'COMMAND_FAILED', rolledBack: true });
    expect(clean.state.files.has(UNIT_PATH)).toBe(false);
  });

  test('an unknown UnitFileState before the apply is not rolledBack; a linked one is put back and checked', async () => {
    const linked = failingRestartHost({ unitFileState: 'linked' });
    linked.state.files.set(UNIT_PATH, OLD_CONTENT);
    await expect(
      installAndStartSystemdUnit({
        unitName: UNIT_NAME,
        unitPath: UNIT_PATH,
        content: CONTENT,
        scope: 'system',
        adapter: linked.adapter,
      }),
    ).rejects.toMatchObject({ code: 'COMMAND_FAILED', rolledBack: true });
    for (const unitFileState of ['']) {
      const fake = failingRestartHost({ unitFileState });
      fake.state.files.set(UNIT_PATH, OLD_CONTENT);
      let caught: unknown;
      try {
        await installAndStartSystemdUnit({
          unitName: UNIT_NAME,
          unitPath: UNIT_PATH,
          content: CONTENT,
          scope: 'system',
          adapter: fake.adapter,
        });
      } catch (error) {
        caught = error;
      }
      expect(caught, unitFileState).toBeInstanceOf(SystemdUnitError);
      if (caught instanceof SystemdUnitError) {
        expect(caught.rolledBack, unitFileState).toBe(false);
        expect(caught.message, unitFileState).toContain(
          `UnitFileState of ${UNIT_NAME} was unknown before the apply`,
        );
      }
      // The file, the run state and the links are put back; only the check cannot be made.
      expect(fake.state.files.get(UNIT_PATH), unitFileState).toBe(OLD_CONTENT);
      expect(fake.state.links.has(WANTS_LINK), unitFileState).toBe(false);
      expect(verbsAfterFirstRestart(fake.state.commands), unitFileState).toEqual([
        'daemon-reload',
        `stop ${UNIT_NAME}`,
        'daemon-reload',
      ]);
    }
  });

  test('reloadSystemdUnit, which does not enable, never disables on rollback', async () => {
    const fake = failingRestartHost({ unitFileState: 'disabled' });
    fake.state.files.set(UNIT_PATH, OLD_CONTENT);
    await expect(
      reloadSystemdUnit({
        unitName: UNIT_NAME,
        unitPath: UNIT_PATH,
        content: CONTENT,
        scope: 'system',
        adapter: fake.adapter,
      }),
    ).rejects.toMatchObject({ code: 'COMMAND_FAILED', rolledBack: true });
    expect(verbsAfterFirstRestart(fake.state.commands)).toEqual([
      'daemon-reload',
      `stop ${UNIT_NAME}`,
    ]);
  });
});

describe('service-host systemd: systemctl by its absolute path', () => {
  test('every systemctl command goes to /usr/bin/systemctl, never a name for PATH to resolve', async () => {
    const fake = restartFailingHost();
    await expect(
      installAndStartSystemdUnit({
        unitName: UNIT_NAME,
        unitPath: UNIT_PATH,
        content: CONTENT,
        scope: 'system',
        adapter: fake.adapter,
      }),
    ).rejects.toBeInstanceOf(SystemdUnitError);
    expect(fake.state.commands.length).toBeGreaterThan(4);
    expect(new Set(fake.state.commands.map((command) => command.executable))).toEqual(
      new Set(['/usr/bin/systemctl']),
    );
  });

  function restartFailingHost() {
    return createFakeSystemdAdapter((_exe, args, state) => {
      if (args.includes('--property=UnitPath')) {
        return { exitCode: 0, stdout: '/etc/systemd/system\n', stderr: '' };
      }
      if (args.includes('restart')) return { exitCode: 1, stdout: '', stderr: 'failed' };
      if (args.includes('show')) {
        return { exitCode: 0, stdout: showFor(state, UNIT_PATH, 'inactive'), stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });
  }
});
