import { describe, expect, test } from 'bun:test';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createDiagnosticJournal } from '../src/application/diagnostic-journal';
import type { DiagnosticJournalLimits } from '../src/application/diagnostic-journal-contract';

const EventSchema = z.object({ message: z.string() }).strict();
const limits: DiagnosticJournalLimits = {
  maxEventBytes: 1_024,
  maxPendingItems: 8,
  maxPendingBytes: 8_192,
  maxFileBytes: 4_096,
  maxFiles: 2,
};

async function withDirectory(body: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'stitchkit-journal-lock-'));
  try {
    await body(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * A PID that is genuinely absent rather than one assumed to be.
 *
 * Spawning and reaping a process yields an identity the kernel has just released, which is what
 * the reclaim path has to recognise. Inventing a large number instead would test a guess about
 * the platform's PID range, and asserting on `kill` would test the mock.
 */
async function reapedPid(): Promise<number> {
  const child = Bun.spawn(['true'], { stdout: 'ignore', stderr: 'ignore' });
  const { pid } = child;
  await child.exited;
  return pid;
}

function ownerRecord(owner: { pid: number; host?: string }): string {
  return `${JSON.stringify({
    pid: owner.pid,
    host: owner.host ?? hostname(),
    acquiredAt: new Date().toISOString(),
  })}\n`;
}

describe('diagnostic journal lock policy', () => {
  test('records its owner and still refuses a present lock by default', async () => {
    await withDirectory(async (directory) => {
      const path = join(directory, 'diagnostic.jsonl');
      const config = { eventSchema: EventSchema, path, limits };
      const journal = await createDiagnosticJournal(config);

      const recorded: unknown = JSON.parse(await readFile(`${path}.lock`, 'utf8'));
      expect(recorded).toMatchObject({ pid: process.pid, host: hostname() });
      expect(journal.getStatus().lock).toEqual({
        policy: 'refuse',
        reclaimedStale: false,
      });

      await expect(createDiagnosticJournal(config)).rejects.toThrow();
      await expect(createDiagnosticJournal({ ...config, lock: 'refuse' })).rejects.toThrow();
      await journal.close();
    });
  });

  test('reclaims a lock whose recorded owner is provably gone, and says so', async () => {
    await withDirectory(async (directory) => {
      const path = join(directory, 'diagnostic.jsonl');
      await writeFile(`${path}.lock`, ownerRecord({ pid: await reapedPid() }), {
        mode: 0o600,
      });

      const journal = await createDiagnosticJournal({
        eventSchema: EventSchema,
        path,
        limits,
        lock: 'reclaim-stale',
      });
      expect(journal.getStatus().lock).toEqual({
        policy: 'reclaim-stale',
        reclaimedStale: true,
      });

      // A reclaimed journal is a working journal, and it owns the lock it took.
      expect(journal.submit({ message: 'after-reclaim' }).outcome).toBe('accepted');
      await journal.flush();
      expect(JSON.parse(await readFile(`${path}.lock`, 'utf8'))).toMatchObject({
        pid: process.pid,
      });
      await journal.close();
      await expect(access(`${path}.lock`)).rejects.toThrow();
    });
  });

  test('refuses a live owner, an ownerless lock and another host under the same policy', async () => {
    await withDirectory(async (directory) => {
      const alive = join(directory, 'alive.jsonl');
      const ownerless = join(directory, 'ownerless.jsonl');
      const foreign = join(directory, 'foreign.jsonl');
      const reclaim = { eventSchema: EventSchema, limits, lock: 'reclaim-stale' } as const;

      // The case the lock exists for: a second writer while the first is running.
      await writeFile(`${alive}.lock`, ownerRecord({ pid: process.pid }), { mode: 0o600 });
      await expect(createDiagnosticJournal({ ...reclaim, path: alive })).rejects.toThrow();

      // A lock written before this policy existed proves nothing about its owner.
      await writeFile(`${ownerless}.lock`, '', { mode: 0o600 });
      await expect(createDiagnosticJournal({ ...reclaim, path: ownerless })).rejects.toThrow();

      // A dead PID on another machine is a live process here, or nothing at all; neither is
      // knowable from this host, so a shared filesystem never reclaims across it.
      await writeFile(
        `${foreign}.lock`,
        ownerRecord({ pid: await reapedPid(), host: `${hostname()}-elsewhere` }),
        { mode: 0o600 },
      );
      await expect(createDiagnosticJournal({ ...reclaim, path: foreign })).rejects.toThrow();
    });
  });

  test('a clean start under the reclaim policy reports no reclaim', async () => {
    await withDirectory(async (directory) => {
      const journal = await createDiagnosticJournal({
        eventSchema: EventSchema,
        path: join(directory, 'diagnostic.jsonl'),
        limits,
        lock: 'reclaim-stale',
      });
      expect(journal.getStatus().lock).toEqual({
        policy: 'reclaim-stale',
        reclaimedStale: false,
      });
      await journal.close();
    });
  });
});
