import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCodexDriver } from '../../src/entrypoints/agent-executor/codex';
import { createFakeCodexAppServer } from '../../src/entrypoints/agent-executor/testing';
import { ambientIn, inScratch } from '../support/engine-driver-harness';

test('Codex status distinguishes login states on stdout and stderr without exposing probe output', () =>
  inScratch('login', async (root) => {
    const cli = join(root, 'login.ts');
    writeFileSync(
      cli,
      'const [code, stream, message] = Bun.argv.slice(2); process[stream].write(message); process.exit(Number(code));',
    );
    const profile = { engine: 'codex' as const, profileId: 'p', home: root };
    for (const stream of ['stdout', 'stderr']) {
      for (const [code, message, state, credential] of [
        ['0', 'Logged in using an API key - sk-private-example', 'signed-in', 'api-key'],
        ['1', 'Not logged in', 'signed-out', 'none'],
        ['2', 'Error reading private profile: sk-private-example', 'unknown', 'unknown'],
        ['0', 'New CLI output including sk-private-example', 'unknown', 'unknown'],
        ['2', 'Not logged in', 'unknown', 'unknown'],
      ] as const) {
        const driver = createCodexDriver({
          executable: process.execPath,
          prefixArgs: [cli, code, stream, message],
          ambient: ambientIn(root),
        });
        const status = await driver.status(profile);
        expect([status.login.state, status.effectiveCredential]).toEqual([state, credential]);
        if (state !== 'signed-in') expect(status.planLimits).toBeUndefined();
        expect(JSON.stringify(status)).not.toContain('sk-private-example');
      }
    }
  }));

test('Codex status replaces complete quota snapshots, merges pushes, and preserves the last observation on pull failure', () =>
  inScratch('limits', async (root) => {
    const dir = join(root, 's');
    mkdirSync(dir, { mode: 0o700 });
    const cli = join(root, 'login.ts');
    writeFileSync(cli, "process.stderr.write('Logged in using ChatGPT\\n');");
    const primary = { usedPercent: 13, windowDurationMins: 300 };
    const secondary = { usedPercent: 30, windowDurationMins: 10080 };
    let snapshot = { rateLimits: { primary, secondary, planType: 'team' } } as Record<
      string,
      unknown
    >;
    const server = await createFakeCodexAppServer({
      socketPath: join(dir, 'a.sock'),
      handlers: {
        'account/rateLimits/read': () => snapshot,
      },
    });
    const pushed = Promise.withResolvers<void>();
    const driver = createCodexDriver({
      executable: process.execPath,
      prefixArgs: [cli],
      ambient: ambientIn(root),
      transport: { kind: 'unix-connect', socketPath: server.socketPath },
      onNotification(event) {
        if (event.method === 'account/rateLimits/updated') pushed.resolve();
      },
    });
    const profile = { engine: 'codex' as const, profileId: 'p', home: root };
    const read = async () => (await driver.status(profile)).planLimits;
    try {
      const full = await read();
      expect(full?.windows.map((w) => w.name).sort()).toEqual(['limit:10080m', 'limit:300m']);
      expect(full?.plan).toBe('team');
      const control = await driver.connectControl({ profile, cwd: root });
      try {
        server.sendNotification('account/rateLimits/updated', {
          rateLimits: { primary: { ...primary, usedPercent: 25 } },
        });
        await pushed.promise;
      } finally {
        await control.close();
      }
      snapshot = { error: { code: -32603, message: 'quota unavailable' } };
      const stale = await read();
      expect(stale?.error).toContain('quota unavailable');
      expect(stale?.windows.map((w) => [w.name, w.usedPercent])).toEqual([
        ['limit:10080m', 30],
        ['limit:300m', 25],
      ]);
      expect(stale?.plan).toBe('team');
      expect((await read())?.observedAt).toBe(stale?.observedAt);
      expect(
        (await driver.status({ ...profile, profileId: 'other' })).planLimits,
      ).toMatchObject({ answer: 'unpublished', windows: [], error: expect.any(String) });
      snapshot = { rateLimits: { primary } };
      const one = await read();
      expect(one).toMatchObject({
        answer: 'known',
        windows: [{ name: 'limit:300m', usedPercent: 13 }],
      });
      expect(one?.plan).toBeUndefined();
      expect(one?.error).toBeUndefined();
      snapshot = { rateLimits: {} };
      const empty = await read();
      if (empty === undefined) throw new Error('Expected a complete empty quota snapshot');
      expect(empty).toMatchObject({ answer: 'unpublished', windows: [] });
      expect(Date.parse(empty?.observedAt ?? '')).toBeGreaterThanOrEqual(
        Date.parse(one?.observedAt ?? ''),
      );
      snapshot = { error: { code: -32603, message: 'quota unavailable' } };
      expect(await read()).toEqual({
        ...empty,
        error: expect.stringContaining('quota unavailable'),
      });
    } finally {
      await server.close();
    }
  }));
