import { expect, test } from 'bun:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserRuntimeFixture } from './gate-environment-fixtures';
import {
  browserFingerprint,
  laneEnvironmentFingerprint,
  laneInputsForSteps,
} from './gate-lane-environment';
import {
  laneEnvironmentIsReusable,
  postgresConnectionFingerprint,
  postgresFingerprint,
} from './gate-memo';

test('unknown external inputs cannot authorize heavy memo reuse', () => {
  expect(laneEnvironmentIsReusable('pg:18.0:hash browsers:chromium-9999')).toBe(true);
  for (const value of [
    'pg:unreachable:hash browsers:chromium-9999',
    'pg:unmeasurable:hash browsers:chromium-9999',
    'pg:unknown:hash browsers:chromium-9999',
    'pg:18.0:hash browsers:absent',
    'pg:18.0:hash browsers:none',
    'browsers:unknown-runtime',
  ])
    expect(laneEnvironmentIsReusable(value)).toBe(false);
});

test('only selected lanes require external measurements', async () => {
  expect(laneInputsForSteps(['tui-packed-lane'])).toEqual([]);
  expect(laneInputsForSteps(['test:postgres-stores', 'supervised-lane'])).toEqual([
    'postgres',
  ]);
  expect(laneInputsForSteps(['starter-head-lane'])).toEqual(['postgres', 'browsers']);
  expect(
    await laneEnvironmentFingerprint({ STARTER_TEST_DATABASE_ADMIN_URL: 'invalid' }, []),
  ).toBe('lanes:none');
  expect(laneEnvironmentIsReusable('lanes:none')).toBe(true);
});

test('secret-only rotations preserve identity and effective endpoint/configuration changes do not', () => {
  const first = syntheticConnection(
    'postgresql://alice@host/db?sslpassword=one&passfile=/config/pass',
    'one',
  );
  expect(postgresConnectionFingerprint(first)).toBe(
    postgresConnectionFingerprint(
      syntheticConnection(
        'postgresql://alice@host/db?sslpassword=two&passfile=/config/pass',
        'two',
      ),
    ),
  );
  expect(postgresConnectionFingerprint(first)).not.toBe(
    postgresConnectionFingerprint(
      syntheticConnection(
        'postgresql://alice@host/db?sslpassword=one&passfile=/other/pass',
        'one',
      ),
    ),
  );
  expect(postgresConnectionFingerprint(first, { PGHOST: 'ignored' })).toBe(
    postgresConnectionFingerprint(first, { PGHOST: 'also-ignored' }),
  );
  expect(postgresConnectionFingerprint('postgresql:///db', { PGHOST: 'one' })).not.toBe(
    postgresConnectionFingerprint('postgresql:///db', { PGHOST: 'two' }),
  );
  expect(postgresConnectionFingerprint('postgresql:///db', { PGPASSWORD: 'one' })).toBe(
    postgresConnectionFingerprint('postgresql:///db', { PGPASSWORD: 'two' }),
  );
});

test('the selected browser runtime rejects missing/mismatched package and unknown generated contexts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gate-browser-context-'));
  try {
    const context = await browserRuntimeFixture(root, 'headless-shell');
    await writeFile(join(root, 'chromium'), 'binary');
    await writeFile(join(root, 'webkit'), 'binary');
    await writeFile(join(root, 'headless-shell'), 'binary');
    const environment = { PLAYWRIGHT_BROWSERS_PATH: root };
    const first = await browserFingerprint(environment, context);
    expect(laneEnvironmentIsReusable(first)).toBe(true);
    await writeFile(join(root, 'chromium'), 'unused full Chrome changed');
    expect(await browserFingerprint(environment, context)).toBe(first);
    await writeFile(join(root, 'headless-shell'), 'selected headless shell changed');
    expect(await browserFingerprint(environment, context)).not.toBe(first);
    expect(await browserFingerprint(environment, { ...context, version: 'wrong' })).toContain(
      'unknown',
    );
    expect(await browserFingerprint({ PLAYWRIGHT_BROWSERS_PATH: '0' }, context)).toContain(
      'unknown-context',
    );
    expect(
      await browserFingerprint({ PLAYWRIGHT_BROWSERS_PATH: 'relative' }, context),
    ).toContain('unknown-context');
    await rm(join(root, 'webkit'));
    expect(await browserFingerprint(environment, context)).toContain('unknown-runtime');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function syntheticConnection(address: string, password = 'secret'): string {
  const url = new URL(address);
  url.password = password;
  return url.href;
}

test('connection identity distinguishes the lane endpoint without storing credentials', () => {
  const first = syntheticConnection('postgresql://alice@host-a:5432/one');
  const base = postgresConnectionFingerprint(first);
  expect(
    postgresConnectionFingerprint(
      syntheticConnection('postgresql://alice@host-a:5432/one', 'changed'),
    ),
  ).toBe(base);
  for (const next of [
    syntheticConnection('postgresql://alice@host-b:5432/one'),
    syntheticConnection('postgresql://bob@host-a:5432/one'),
    syntheticConnection('postgresql://alice@host-a:5432/two'),
    syntheticConnection('postgresql://alice@host-a:5432/one?host=host-b&port=5433'),
    syntheticConnection('postgresql://alice@host-a:5432/one?user=bob'),
  ]) {
    expect(postgresConnectionFingerprint(next)).not.toBe(base);
  }
  expect(base).not.toContain('alice');
  expect(base).not.toContain('secret');
  expect(base).not.toContain('host-a');
  expect(postgresConnectionFingerprint(`${first}?host=a&port=1`)).not.toBe(
    postgresConnectionFingerprint(`${first}?host=b&port=2`),
  );
  expect(postgresConnectionFingerprint(`${first}?password=one`)).toBe(
    postgresConnectionFingerprint(`${first}?password=two`),
  );
});

test('a hung PostgreSQL probe settles within its budget, while a healthy probe keeps the measured version', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gate-pg-probe-'));
  try {
    const path = join(root, 'sudo');
    await writeFile(
      path,
      '#!/usr/bin/env bun\nif (!Bun.argv.includes("-n") || !Bun.argv.includes("-w") || !Bun.argv.includes("postgres")) process.exit(1); if (process.env.GATE_PROBE_MODE === "hang") await new Promise(() => {}); else if (process.env.GATE_PROBE_MODE === "flood") console.log("x".repeat(65536)); else console.log(JSON.stringify({version:"18.0",database:"postgres",user:"postgres",address:"local-socket",port:0}));\n',
    );
    await chmod(path, 0o700);
    const env = {
      PATH: `${root}:${Bun.env.PATH ?? ''}`,
    };
    expect(await postgresFingerprint(env, 1000)).toContain('pg:18.0:');
    const start = performance.now();
    const hung = await postgresFingerprint({ ...env, GATE_PROBE_MODE: 'hang' }, 40);
    expect(hung).toContain('pg:unmeasurable:');
    expect(hung).not.toContain('secret');
    expect(performance.now() - start).toBeLessThan(700);
    expect(await postgresFingerprint({ ...env, GATE_PROBE_MODE: 'flood' }, 1000)).toContain(
      'pg:unmeasurable:',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
