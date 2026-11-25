import { describe, expect, test } from 'bun:test';
import {
  checkSystemdUnit,
  installAndStartSystemdUnit,
  type LaunchdHostAdapter,
  reloadLaunchdJob,
  renderSystemdServiceUnit,
} from '../src/entrypoints/service-host';
import { createFakeSystemdAdapter, NOT_FOUND_SHOW } from './support/fake-systemd-host';

const UNIT_NAME = 'example-agent.service';
const CONTENT = renderSystemdServiceUnit({
  description: 'Example agent',
  scope: 'system',
  execStart: ['/opt/example/agent'],
});

/** Spellings of a path that the manager never reports back as given. */
const UNIT_SPELLINGS = [
  'etc/systemd/system/example-agent.service',
  './example-agent.service',
  '/etc/systemd//system/example-agent.service',
  '/etc/systemd/./system/example-agent.service',
  '/etc/systemd/user/../system/example-agent.service',
  '/etc/systemd/system/example-agent.service/',
];

function recordingSystemdHost() {
  return createFakeSystemdAdapter((_exe, args) => {
    if (args.includes('--property=UnitPath'))
      return { exitCode: 0, stdout: '/etc/systemd/system\n', stderr: '' };
    if (args.includes('show')) return { exitCode: 0, stdout: NOT_FOUND_SHOW, stderr: '' };
    return { exitCode: 0, stdout: '', stderr: '' };
  });
}

describe('service-host: a unit or plist path in another spelling is refused before any command', () => {
  test('checkSystemdUnit and installAndStartSystemdUnit refuse a relative or unnormalised unitPath', async () => {
    for (const unitPath of UNIT_SPELLINGS) {
      const fake = recordingSystemdHost();
      await expect(
        checkSystemdUnit({
          unitName: UNIT_NAME,
          unitPath,
          expectedContent: CONTENT,
          scope: 'system',
          adapter: fake.adapter,
        }),
        unitPath,
      ).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
      await expect(
        installAndStartSystemdUnit({
          unitName: UNIT_NAME,
          unitPath,
          content: CONTENT,
          scope: 'system',
          adapter: fake.adapter,
        }),
        unitPath,
      ).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
      expect(fake.state.commands, unitPath).toEqual([]);
      expect(fake.state.files.size, unitPath).toBe(0);
    }
    // Positive control: the normal spelling is inspected.
    const fake = recordingSystemdHost();
    const result = await checkSystemdUnit({
      unitName: UNIT_NAME,
      unitPath: '/etc/systemd/system/example-agent.service',
      expectedContent: CONTENT,
      scope: 'system',
      adapter: fake.adapter,
    });
    expect(result.status).toBe('missing');
    expect(fake.state.commands.length).toBeGreaterThan(0);
  });

  test('reloadLaunchdJob refuses a relative or unnormalised plistPath', async () => {
    const commands: string[][] = [];
    const adapter: LaunchdHostAdapter = {
      async runCommand(executable, args) {
        commands.push([executable, ...args]);
        return { exitCode: 113, stdout: '', stderr: 'Could not find service' };
      },
      readFile: async () => null,
      writeFileAtomic: async () => undefined,
      removeFile: async () => undefined,
      inspectPath: async () => ({ kind: 'missing' }),
      canonicalPath: async (path) => path,
      now: () => 0,
      sleep: async () => undefined,
    };
    const base = '/Users/example-user/Library/LaunchAgents/com.example.agent.plist';
    for (const plistPath of [
      'Library/LaunchAgents/com.example.agent.plist',
      '/Users/example-user/Library//LaunchAgents/com.example.agent.plist',
      '/Users/example-user/./Library/LaunchAgents/com.example.agent.plist',
      '/Users/example-user/Library/LaunchAgents/../LaunchAgents/com.example.agent.plist',
      `${base}/`,
    ]) {
      await expect(
        reloadLaunchdJob({
          label: 'com.example.agent',
          uid: 501,
          plistPath,
          content: '<plist/>',
          validatePlist: 'none',
          adapter,
        }),
        plistPath,
      ).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    }
    expect(commands).toEqual([]);
  });
});
