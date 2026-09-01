import { describe, expect, test } from 'bun:test';
import { lstat, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createDiagnosticJournal } from '../src/application/diagnostic-journal';
import {
  DiagnosticJournalFrameSchema,
  type DiagnosticJournalLimits,
} from '../src/application/diagnostic-journal-contract';
import { createDiagnosticJournalManager } from '../src/application/diagnostic-journal-manager';
import {
  type DiagnosticJournalStorage,
  DiagnosticJournalStorageError,
} from '../src/application/diagnostic-journal-storage';

const EventSchema = z.object({ message: z.string() }).strict();
const epoch = '00000000-0000-4000-8000-000000000001';
const limits: DiagnosticJournalLimits = {
  maxEventBytes: 1_024,
  maxPendingItems: 2,
  maxPendingBytes: 4_096,
  maxFileBytes: 4_096,
  maxFiles: 3,
};

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function fakeStorage(
  options: { readonly hold?: Promise<void>; readonly fail?: 'write' | 'rotation' } = {},
): { readonly storage: DiagnosticJournalStorage; readonly frames: string[] } {
  const frames: string[] = [];
  let currentFileBytes = 0;
  return {
    frames,
    storage: {
      reclaimedStale: false,
      async append(bytes) {
        frames.push(new TextDecoder().decode(bytes));
        if (options.hold) await options.hold;
        if (options.fail) {
          throw new DiagnosticJournalStorageError(options.fail, 'injected failure');
        }
        currentFileBytes += bytes.byteLength;
        return {
          currentFileBytes,
          retainedFiles: 1,
          rotations: 0,
          partialTails: 0,
          rotated: false,
        };
      },
      snapshot: () => ({
        currentFileBytes,
        retainedFiles: 1,
        rotations: 0,
        partialTails: 0,
      }),
      close: async () => undefined,
    },
  };
}

function parseFrame(line: string) {
  return DiagnosticJournalFrameSchema.parse(JSON.parse(line));
}

describe('bounded ordered diagnostic journal', () => {
  test('orders accepted frames and refuses pressure before memory grows', async () => {
    const held = deferred();
    const { storage, frames } = fakeStorage({ hold: held.promise });
    const journal = createDiagnosticJournalManager(
      {
        eventSchema: EventSchema,
        epoch,
        limits,
        lock: { policy: 'refuse' as const, reclaimedStale: false },
      },
      storage,
    );

    expect(journal.submit({ message: 'first' })).toMatchObject({
      outcome: 'accepted',
      sequence: 1,
    });
    expect(journal.submit({ message: 'second' })).toMatchObject({
      outcome: 'accepted',
      sequence: 2,
    });
    for (let index = 0; index < 100; index += 1) {
      expect(journal.submit({ message: `overflow-${index}` })).toEqual({
        outcome: 'refused',
        reason: 'item-capacity',
      });
    }
    expect(journal.getStatus()).toMatchObject({ pendingItems: 2, accepted: 2, refused: 100 });

    held.resolve();
    await expect(journal.flush()).resolves.toMatchObject({ outcome: 'settled' });
    const parsed = frames.map(parseFrame);
    expect(parsed.map((frame) => [frame.sequence, frame.event])).toEqual([
      [1, { message: 'first' }],
      [2, { message: 'second' }],
    ]);
    await journal.close();
  });

  test('invalid, oversized and byte-capacity refusals consume no sequence', async () => {
    const held = deferred();
    const { storage } = fakeStorage({ hold: held.promise });
    const journal = createDiagnosticJournalManager(
      {
        eventSchema: z.unknown().pipe(EventSchema),
        epoch,
        lock: { policy: 'refuse' as const, reclaimedStale: false },
        limits: { ...limits, maxEventBytes: 16, maxPendingItems: 8, maxPendingBytes: 180 },
      },
      storage,
    );

    expect(journal.submit({ nope: true })).toEqual({ outcome: 'refused', reason: 'invalid' });
    expect(journal.submit({ message: 'x'.repeat(100) })).toEqual({
      outcome: 'refused',
      reason: 'oversized',
    });
    expect(journal.submit({ message: 'a' })).toMatchObject({
      outcome: 'accepted',
      sequence: 1,
    });
    expect(journal.submit({ message: 'b' })).toEqual({
      outcome: 'refused',
      reason: 'byte-capacity',
    });
    held.resolve();
    await journal.close();
    expect(journal.getStatus()).toMatchObject({
      accepted: 1,
      refusals: { invalid: 1, oversized: 1, 'byte-capacity': 1 },
      lastAcceptedSequence: 1,
    });
  });

  test('writer failure is terminal, drains leases and isolates its observer', async () => {
    const { storage } = fakeStorage({ fail: 'write' });
    const failures: string[] = [];
    const journal = createDiagnosticJournalManager(
      {
        eventSchema: EventSchema,
        epoch,
        lock: { policy: 'refuse' as const, reclaimedStale: false },
        limits,
        onFailure: ({ phase }) => {
          failures.push(phase);
          throw new Error('observer failure');
        },
      },
      storage,
    );
    journal.submit({ message: 'one' });
    journal.submit({ message: 'two' });
    await journal.flush();
    await Promise.resolve();
    expect(journal.submit({ message: 'late' })).toEqual({
      outcome: 'refused',
      reason: 'failed',
    });
    await journal.close();
    expect(failures).toEqual(['write']);
    expect(journal.getStatus()).toMatchObject({
      state: 'failed',
      written: 0,
      failedRecords: 2,
      pendingItems: 0,
      lastFailure: { phase: 'write', sequence: 1 },
    });
  });

  test('caller timeout never releases a physically running write', async () => {
    const held = deferred();
    const { storage } = fakeStorage({ hold: held.promise });
    const journal = createDiagnosticJournalManager(
      {
        eventSchema: EventSchema,
        epoch,
        limits,
        lock: { policy: 'refuse' as const, reclaimedStale: false },
      },
      storage,
    );
    journal.submit({ message: 'held' });
    const timedOut = await journal.close({ timeoutMs: 5 });
    expect(timedOut).toMatchObject({ outcome: 'timed-out', pendingItems: 1 });
    expect(journal.getStatus()).toMatchObject({ state: 'draining', pendingItems: 1 });
    expect(journal.submit({ message: 'late' })).toEqual({
      outcome: 'refused',
      reason: 'closed',
    });
    held.resolve();
    await expect(journal.close()).resolves.toMatchObject({ outcome: 'closed' });
    expect(journal.getStatus()).toMatchObject({ state: 'closed', pendingItems: 0 });
  });

  test('cancellation bounds concurrent waiters without cancelling physical close', async () => {
    const held = deferred();
    const { storage } = fakeStorage({ hold: held.promise });
    const journal = createDiagnosticJournalManager(
      {
        eventSchema: EventSchema,
        epoch,
        limits,
        lock: { policy: 'refuse' as const, reclaimedStale: false },
      },
      storage,
    );
    journal.submit({ message: 'held' });
    const physicalClose = journal.close();
    const controller = new AbortController();
    const cancelledClose = journal.close({ signal: controller.signal });
    controller.abort();
    await expect(cancelledClose).resolves.toMatchObject({
      outcome: 'cancelled',
      pendingItems: 1,
    });
    expect(journal.getStatus()).toMatchObject({ state: 'draining', pendingItems: 1 });
    held.resolve();
    await expect(physicalClose).resolves.toMatchObject({ outcome: 'closed' });
  });

  test('rotates finite files, owns one path and marks a partial-tail restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stitchkit-journal-'));
    try {
      const path = join(directory, 'diagnostic.jsonl');
      const config = {
        eventSchema: EventSchema,
        path,
        limits: { ...limits, maxEventBytes: 128, maxFileBytes: 180, maxFiles: 2 },
      };
      const journal = await createDiagnosticJournal(config);
      const firstEpoch = journal.getStatus().epoch;
      await expect(createDiagnosticJournal(config)).rejects.toThrow();
      for (let index = 0; index < 5; index += 1) {
        expect(journal.submit({ message: `event-${index}-${'x'.repeat(20)}` }).outcome).toBe(
          'accepted',
        );
        await journal.flush();
      }
      await journal.close();
      const names = (await readdir(directory)).filter((name) =>
        name.startsWith('diagnostic.jsonl'),
      );
      expect(names.sort()).toEqual(['diagnostic.jsonl', 'diagnostic.jsonl.1']);
      expect((await lstat(path)).mode & 0o777).toBe(0o600);

      await writeFile(path, '{"partial":true}');
      const restarted = await createDiagnosticJournal(config);
      expect(restarted.getStatus()).toMatchObject({ partialTails: 1, rotations: 1 });
      expect(restarted.getStatus().epoch).not.toBe(firstEpoch);
      expect(restarted.submit({ message: 'after-restart' })).toMatchObject({
        outcome: 'accepted',
        sequence: 1,
      });
      await restarted.close();
      const current = await readFile(path, 'utf8');
      const frame = parseFrame(current);
      expect(frame.sequence).toBe(1);
      expect(frame.event).toEqual({ message: 'after-restart' });
      expect(await readFile(`${path}.1`, 'utf8')).toBe('{"partial":true}');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('rotation failure is explicit and closes without following a symlink generation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stitchkit-journal-rotation-'));
    try {
      const path = join(directory, 'diagnostic.jsonl');
      await writeFile(path, `${'x'.repeat(100)}\n`);
      const journal = await createDiagnosticJournal({
        eventSchema: EventSchema,
        path,
        limits: { ...limits, maxFileBytes: 180, maxFiles: 2 },
      });
      await symlink(path, `${path}.1`);
      expect(journal.submit({ message: 'rotate-now' })).toMatchObject({ outcome: 'accepted' });
      await journal.flush();
      await journal.close();
      expect(journal.getStatus()).toMatchObject({
        state: 'failed',
        rotationFailures: 1,
        lastFailure: { phase: 'rotation', sequence: 1 },
      });
      expect((await lstat(`${path}.1`)).isSymbolicLink()).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
