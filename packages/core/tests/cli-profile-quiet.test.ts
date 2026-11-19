import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCli } from '../src/entrypoints/cli';
import { runNativeCommand } from '../src/process/command';
import { profileGlobals, profileStore, profileTool } from './fixtures/cli-profile-executable';
import { reapAfterEachTest, trackGroupLeader } from './support/process-reaper';

reapAfterEachTest();

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function soleProfile(announce?: (line: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'stitchkit-quiet-profile-'));
  directories.push(directory);
  const store = profileStore(directory, announce);
  const file = store.write('prod', { url: 'https://prod.example.test', token: 'fixture-key' });
  return { store, file, notice: `[prod] using the only configured profile (${file})` };
}

async function runExecutable(directory: string, argv: string[]) {
  const result = await runNativeCommand({
    executable: process.execPath,
    args: [
      '--no-env-file',
      join(import.meta.dir, 'fixtures/cli-profile-executable.ts'),
      ...argv,
    ],
    env: { STITCHKIT_TEST_CLI_PROFILE_DIR: directory },
    capture: true,
    timeoutMs: 4000,
    maxOutputBytes: 8192,
    onLeaderStarted: trackGroupLeader,
  });
  const decoder = new TextDecoder();
  return {
    code: result.exitCode,
    out: decoder.decode(result.stdout),
    err: decoder.decode(result.stderr),
  };
}

async function runEmbedded(argv: string[], store: ReturnType<typeof profileStore>) {
  let out = '';
  let err = '';
  let code = -1;
  let catalogBuilds = 0;
  await createCli({
    name: 'profile-fixture',
    version: '1.0.0',
    argv,
    defaultCommand: 'endpoint',
    globalOptions: profileGlobals,
    resolveAuth: async ({ profile }) => {
      await Promise.resolve();
      return store.resolve(profile).name;
    },
    runtimeTools: (profile) => {
      catalogBuilds++;
      if (profile === undefined) throw new Error('Expected a resolved profile');
      return [profileTool(profile)];
    },
    exit: (value) => {
      code = value;
    },
    stdout: (line) => {
      out += line;
    },
    stderr: (line) => {
      err += line;
    },
  });
  return { out, err, code, catalogBuilds };
}

test('--quiet suppresses sole-profile stderr before the managed CLI starts', async () => {
  const { store, notice } = soleProfile();
  const cases = [
    { flags: [], expected: `${notice}\n` },
    { flags: ['--quiet'], expected: '' },
    { flags: ['--quiet=YES'], expected: '' },
    { flags: ['--quiet', 'true'], expected: '' },
    { flags: ['--quiet=false'], expected: `${notice}\n` },
    { flags: ['--quiet', 'false'], expected: `${notice}\n` },
    { flags: ['--', '--quiet'], expected: `${notice}\n`, text: '--quiet' },
  ];
  for (const { flags, expected, text } of cases) {
    const result = await runExecutable(store.directory, ['endpoint', '--json', ...flags]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toEqual({
      profile: 'prod',
      input: text === undefined ? {} : { text },
    });
    expect(result.err).toBe(expected);
  }
}, 15_000);

test('a leading --quiet runs the same discovered command with the same profile', async () => {
  const { store, notice } = soleProfile();
  const endpoint = (argv: string[]) => runExecutable(store.directory, argv);
  const trailing = await endpoint(['endpoint', '--quiet', '--json']);
  expect(trailing).toEqual({ code: 0, out: '{"profile":"prod","input":{}}\n', err: '' });
  expect(await endpoint(['--quiet', 'endpoint', '--json'])).toEqual(trailing);
  expect(await endpoint(['--quiet', 'false', 'endpoint', '--json'])).toEqual({
    ...trailing,
    err: `${notice}\n`,
  });
  expect(await endpoint(['--quiet', 'endpoint', 'false', '--json'])).toEqual({
    ...trailing,
    out: '{"profile":"prod","input":{"text":"false"}}\n',
  });
}, 15_000);

test('profile notices follow each concurrent invocation including dynamic help', async () => {
  const { store, notice } = soleProfile();
  const [quiet, loud] = await Promise.all([
    runEmbedded(['--quiet', '--help'], store),
    runEmbedded(['endpoint', '--quiet', 'false', '--label', 'fixture', '--json'], store),
  ]);
  expect(quiet.code).toBe(0);
  expect(quiet.catalogBuilds).toBe(1);
  expect(quiet.out).toContain('Report the selected profile');
  expect(quiet.err).toBe('');
  expect(loud).toEqual({
    code: 0,
    catalogBuilds: 1,
    out: '{"profile":"prod","input":{}}\n',
    err: `${notice}\n`,
  });
});

test('profile notices respect the original boundary of a quiet flag', async () => {
  const { store, notice } = soleProfile();
  const quiet = {
    code: 0,
    catalogBuilds: 1,
    out: '{"profile":"prod","input":{"text":"false"}}\n',
    err: '',
  };
  expect(await runEmbedded(['--quiet', 'endpoint', 'false', '--json'], store)).toEqual(quiet);
  expect(
    await runEmbedded(['endpoint', '--quiet', '--label', 'fixture', 'false', '--json'], store),
  ).toEqual(quiet);
  expect(await runEmbedded(['--quiet', 'false', 'endpoint', '--json'], store)).toEqual({
    code: 0,
    catalogBuilds: 1,
    out: '{"profile":"prod","input":{}}\n',
    err: `${notice}\n`,
  });
});

test('--quiet leaves custom profile announcements with their caller', async () => {
  const lines: string[] = [];
  const { store, notice } = soleProfile((line) => lines.push(line));
  const result = await runEmbedded(['endpoint', '--quiet', '--json'], store);
  expect(result.code).toBe(0);
  expect(result.err).toBe('');
  expect(lines).toEqual([notice]);
});

test('--quiet preserves profile refusals and their diagnostics', async () => {
  const { store, file } = soleProfile();
  const missing = await runEmbedded(
    ['endpoint', '--quiet', '--json', '--profile', 'absent'],
    store,
  );
  expect(missing.code).toBe(4);
  expect(missing.out).toBe('');
  expect(missing.catalogBuilds).toBe(0);
  expect(JSON.parse(missing.err)).toMatchObject({
    error: 'NOT_FOUND',
    details: {
      message: `profile "absent" is not configured; expected ${store.pathFor('absent')}`,
    },
  });

  chmodSync(file, 0o644);
  const unsafe = await runEmbedded(['endpoint', '--quiet', '--json'], store);
  expect(unsafe.code).toBe(3);
  expect(unsafe.out).toBe('');
  expect(unsafe.catalogBuilds).toBe(0);
  expect(JSON.parse(unsafe.err)).toMatchObject({
    error: 'FORBIDDEN',
    details: { message: `profile "prod" is readable by other users — run: chmod 600 ${file}` },
  });
});
