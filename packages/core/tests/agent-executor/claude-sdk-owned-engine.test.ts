/**
 * The engine a Claude SDK session spawns itself goes through `stitchkit/process`: `close()` waits
 * until it is gone, and it does not outlive a host killed with SIGKILL.
 */
import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { probeLiveness } from '../../src/internal/process-identity';
import { inScratch } from '../support/engine-driver-harness';
import { reapAfterEachTest, trackPidFile, trackProcess } from '../support/process-reaper';
import { observe, until } from '../support/until';

reapAfterEachTest();

const HOST = resolve(import.meta.dir, '../fixtures/claude-sdk-owned-engine-host.ts');

function startHost(root: string, ...args: string[]) {
  trackPidFile(join(root, 'engine.pid'));
  trackPidFile(join(root, 'leader.pid'));
  const host = spawn(process.execPath, [HOST, root, ...args], { stdio: 'ignore' });
  trackProcess(host.pid);
  if (host.pid === undefined) throw new Error('host started without a pid');
  return host.pid;
}

function pidIn(path: string): number | undefined {
  if (!existsSync(path)) return undefined;
  const pid = Number(readFileSync(path, 'utf8'));
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

test('close() resolves only once a SIGTERM-trapping engine the driver spawned has exited', () =>
  inScratch('claude-sdk-close-waits', async (root) => {
    startHost(root, '200', '--close');
    const engine = await observe(() => pidIn(join(root, 'engine.pid')), 'engine pid', 15_000);
    await until(() => existsSync(join(root, 'closed')), 'session closed', 15_000);
    // `closed` is written after `await session.close()`: the engine must already be gone.
    expect(await probeLiveness(engine)).toBe('gone');
  }));

test('SIGKILL of the host ends the engine group the driver spawned', () =>
  inScratch('claude-sdk-owner-loss', async (root) => {
    const host = startHost(root, '0');
    await until(() => existsSync(join(root, 'host-ready')), 'host ready', 15_000);
    const engine = await observe(() => pidIn(join(root, 'engine.pid')), 'engine pid', 15_000);
    const leader = await observe(() => pidIn(join(root, 'leader.pid')), 'leader pid', 15_000);
    expect(await probeLiveness(engine)).toBe('alive');
    process.kill(host, 'SIGKILL');
    await until(
      async () =>
        (await probeLiveness(engine)) === 'gone' && (await probeLiveness(leader)) === 'gone',
      'engine group cleanup',
    );
  }));
