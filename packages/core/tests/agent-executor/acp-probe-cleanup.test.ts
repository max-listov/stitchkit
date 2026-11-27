import { expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createAcpDriver } from '../../src/entrypoints/agent-executor/acp';
import { probeLiveness } from '../../src/internal/process-identity';
import { ambientIn, inScratch } from '../support/engine-driver-harness';
import { reapAfterEachTest, trackPidFile } from '../support/process-reaper';

reapAfterEachTest();

const CLEANUP_PEER = resolve(import.meta.dir, '../fixtures/acp-probe-cleanup-peer.ts');

function readCalls(root: string): Array<[string, string | undefined]> {
  const path = join(root, 'calls');
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf8').trim();
  if (raw.length === 0) return [];
  return raw.split('\n').map((line) => JSON.parse(line));
}

async function waitForMethodCall(root: string, method: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (readCalls(root).some(([seen]) => seen === method)) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ACP cleanup peer to receive ${method}`);
}

test.each(['ok', 'close', 'delete', 'close-delete', 'invalid-delete', 'unsupported'])(
  'ACP capability probe cleans up its own session and stops the provider (%s)',
  (mode) =>
    inScratch('acp-clean', async (root) => {
      const store = join(root, 'sessions.json');
      writeFileSync(store, JSON.stringify(['user-id']));
      trackPidFile(join(root, 'pid'));
      const driver = createAcpDriver({
        executable: process.execPath,
        args: [CLEANUP_PEER, root, mode],
        ambient: ambientIn(root),
      });
      const probe = driver.probeCapabilities({
        profile: { engine: 'acp', profileId: 'probe', home: root },
        cwd: root,
      });
      if (mode === 'ok' || mode === 'unsupported') {
        expect(await probe).toMatchObject({ initialized: { protocolVersion: 1 }, models: [] });
      } else {
        const error: unknown = await probe.catch((cause: unknown) => cause);
        expect(error).toBeInstanceOf(Error);
        if (mode.includes('close')) expect(String(error)).toContain('session/close');
        if (mode.includes('delete')) expect(String(error)).toContain('session/delete');
        if (mode === 'invalid-delete') {
          expect(error).toBeInstanceOf(AggregateError);
          expect(String(Reflect.get(Object(error), 'cause'))).toContain('configOptions');
        }
      }
      const cleanup = readCalls(root).slice(2);
      expect(cleanup).toEqual(
        mode === 'unsupported'
          ? []
          : [
              ['session/close', 'probe-id'],
              ['session/delete', 'probe-id'],
            ],
      );
      expect(JSON.parse(readFileSync(store, 'utf8'))).toEqual(
        mode.includes('delete') || mode === 'unsupported'
          ? ['user-id', 'probe-id']
          : ['user-id'],
      );
      const pid = Number(readFileSync(join(root, 'pid'), 'utf8'));
      expect(await probeLiveness(process.pid)).toBe('alive');
      expect(await probeLiveness(pid)).toBe('gone');
    }),
);

// A close bound of 1.5 s: the default 5 s would outlast the test runner's own timeout.
const CLEANUP_BOUND_MS = 1_500;

test.each(['hang-close', 'hang-delete'] as const)(
  'ACP capability probe still cleans up after its timeout when %s, and leads with the timeout reason',
  (mode) =>
    inScratch(`acp-timeout-${mode}`, async (root) => {
      const store = join(root, 'sessions.json');
      writeFileSync(store, JSON.stringify(['user-id']));
      trackPidFile(join(root, 'pid'));
      const driver = createAcpDriver({
        executable: process.execPath,
        args: [CLEANUP_PEER, root, mode],
        ambient: ambientIn(root),
        requestTimeoutMs: CLEANUP_BOUND_MS,
      });
      const error: unknown = await driver
        .probeCapabilities({
          profile: { engine: 'acp', profileId: 'probe', home: root },
          cwd: root,
          timeoutMs: 500,
        })
        .catch((cause: unknown) => cause);
      // The hung operation failed on its own bound: the timeout leads, that failure follows.
      expect(error).toBeInstanceOf(AggregateError);
      const failure = error instanceof AggregateError ? error : undefined;
      expect(failure?.cause).toBeInstanceOf(Error);
      expect(failure?.errors[0] instanceof Error ? failure.errors[0].message : '').toBe(
        'ACP capability probe timed out after 500 ms',
      );
      expect(String(failure?.errors[1])).toContain(
        mode === 'hang-close' ? 'session/close failed' : 'session/delete failed',
      );
      // Delete ran after the timeout too: before the fix the probe stopped at the deadline.
      expect(readCalls(root).slice(2)).toEqual([
        ['session/close', 'probe-id'],
        ['session/delete', 'probe-id'],
      ]);
      if (mode === 'hang-close')
        expect(JSON.parse(readFileSync(store, 'utf8'))).toEqual(['user-id']);
      const pid = Number(readFileSync(join(root, 'pid'), 'utf8'));
      expect(await probeLiveness(process.pid)).toBe('alive');
      expect(await probeLiveness(pid)).toBe('gone');
    }),
);

test('ACP capability probe aborted while session/close is in flight finishes cleanup and rejects with the caller reason', () =>
  inScratch('acp-abort-slow-close', async (root) => {
    const store = join(root, 'sessions.json');
    writeFileSync(store, JSON.stringify(['user-id']));
    trackPidFile(join(root, 'pid'));
    const driver = createAcpDriver({
      executable: process.execPath,
      args: [CLEANUP_PEER, root, 'slow-close'],
      ambient: ambientIn(root),
    });
    const controller = new AbortController();
    const reason = new Error('caller-cancelled');
    const pending = driver.probeCapabilities({
      profile: { engine: 'acp', profileId: 'probe', home: root },
      cwd: root,
      signal: controller.signal,
    });
    await waitForMethodCall(root, 'session/close');
    controller.abort(reason);
    writeFileSync(join(root, 'release-close'), '1');
    const error: unknown = await pending.catch((cause: unknown) => cause);
    expect(error).toBe(reason);
    expect(readCalls(root).slice(2)).toEqual([
      ['session/close', 'probe-id'],
      ['session/delete', 'probe-id'],
    ]);
    // The probe session is gone from the provider; the user's session stays.
    expect(JSON.parse(readFileSync(store, 'utf8'))).toEqual(['user-id']);
    const pid = Number(readFileSync(join(root, 'pid'), 'utf8'));
    expect(await probeLiveness(pid)).toBe('gone');
  }));

test.each(['hang-close', 'hang-delete', 'invalid-hang-close'] as const)(
  'ACP capability probe aborted during %s still attempts every cleanup and leads with the caller reason',
  (mode) =>
    inScratch(`acp-abort-${mode}`, async (root) => {
      const store = join(root, 'sessions.json');
      writeFileSync(store, JSON.stringify(['user-id']));
      trackPidFile(join(root, 'pid'));
      const driver = createAcpDriver({
        executable: process.execPath,
        args: [CLEANUP_PEER, root, mode],
        ambient: ambientIn(root),
        requestTimeoutMs: CLEANUP_BOUND_MS,
      });
      const controller = new AbortController();
      const reason = new Error(`caller-cancelled-${mode}`);
      const pending = driver.probeCapabilities({
        profile: { engine: 'acp', profileId: 'probe', home: root },
        cwd: root,
        signal: controller.signal,
      });
      await waitForMethodCall(
        root,
        mode === 'hang-delete' ? 'session/delete' : 'session/close',
      );
      controller.abort(reason);
      const error: unknown = await pending.catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(AggregateError);
      const failure = error instanceof AggregateError ? error : undefined;
      expect(failure?.cause).toBe(reason);
      expect(failure?.errors[0]).toBe(reason);
      expect(readCalls(root).slice(2)).toEqual([
        ['session/close', 'probe-id'],
        ['session/delete', 'probe-id'],
      ]);
      const pid = Number(readFileSync(join(root, 'pid'), 'utf8'));
      expect(await probeLiveness(process.pid)).toBe('alive');
      expect(await probeLiveness(pid)).toBe('gone');
    }),
);

test('ACP capability probe still runs session/delete when local requestTimeoutMs expires on session/close while probe signal stays alive', () =>
  inScratch('acp-local-close-timeout', async (root) => {
    const store = join(root, 'sessions.json');
    writeFileSync(store, JSON.stringify(['user-id']));
    trackPidFile(join(root, 'pid'));
    const driver = createAcpDriver({
      executable: process.execPath,
      args: [CLEANUP_PEER, root, 'hang-close'],
      ambient: ambientIn(root),
      // The bound covers initialize and session/new too: 150 ms timed initialize out on a loaded host.
      requestTimeoutMs: CLEANUP_BOUND_MS,
    });
    const error: unknown = await driver
      .probeCapabilities({
        profile: { engine: 'acp', profileId: 'probe', home: root },
        cwd: root,
        timeoutMs: 5_000,
      })
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(AggregateError);
    expect(String(error)).toContain('session/close failed');
    expect(readCalls(root).slice(2)).toEqual([
      ['session/close', 'probe-id'],
      ['session/delete', 'probe-id'],
    ]);
    // Because session/delete still ran, probe-id was removed while user-id stayed intact.
    expect(JSON.parse(readFileSync(store, 'utf8'))).toEqual(['user-id']);
    const pid = Number(readFileSync(join(root, 'pid'), 'utf8'));
    expect(await probeLiveness(process.pid)).toBe('alive');
    expect(await probeLiveness(pid)).toBe('gone');
  }));
