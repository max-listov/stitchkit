import { expect, test } from 'bun:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  ])
    expect(laneEnvironmentIsReusable(value)).toBe(false);
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
    const path = join(root, 'psql');
    await writeFile(
      path,
      '#!/usr/bin/env bun\nif (process.env.GATE_PROBE_MODE === "hang") await new Promise(() => {}); else console.log("PostgreSQL 18.0 test");\n',
    );
    await chmod(path, 0o700);
    const env = {
      PATH: `${root}:${Bun.env.PATH ?? ''}`,
      STARTER_TEST_DATABASE_ADMIN_URL: syntheticConnection('postgresql://user@fake/db'),
    };
    expect(await postgresFingerprint(env, 1000)).toContain('pg:18.0:');
    const start = performance.now();
    const hung = await postgresFingerprint({ ...env, GATE_PROBE_MODE: 'hang' }, 40);
    expect(hung).toContain('pg:unmeasurable:');
    expect(hung).not.toContain('secret');
    expect(performance.now() - start).toBeLessThan(700);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
