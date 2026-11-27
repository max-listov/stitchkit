import { expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createAcpDriver } from '../../src/entrypoints/agent-executor/acp';
import { probeLiveness } from '../../src/internal/process-identity';
import { ambientIn, inScratch } from '../support/engine-driver-harness';
import { reapAfterEachTest, trackPidFile } from '../support/process-reaper';

reapAfterEachTest();

test.each(['ok', 'close', 'delete', 'close-delete', 'invalid-delete', 'unsupported'])(
  'ACP capability probe cleans up its own session and stops the provider (%s)',
  (mode) =>
    inScratch('acp-clean', async (root) => {
      const store = join(root, 'sessions.json');
      writeFileSync(store, JSON.stringify(['user-id']));
      trackPidFile(join(root, 'pid'));
      const driver = createAcpDriver({
        executable: process.execPath,
        args: [resolve(import.meta.dir, '../fixtures/acp-probe-cleanup-peer.ts'), root, mode],
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
          expect(String((error as AggregateError).cause)).toContain('configOptions');
        }
      }
      const cleanup = readFileSync(join(root, 'calls'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
        .slice(2);
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
