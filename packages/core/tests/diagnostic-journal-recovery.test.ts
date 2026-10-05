import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createDiagnosticJournal } from '../src/application/diagnostic-journal';
import { DiagnosticJournalRecoveryError } from '../src/application/diagnostic-journal-read-contract';
import { readDiagnosticJournal } from '../src/entrypoints/application/diagnostic-journal';

const eventSchema = z.object({ message: z.string() }).strict();
const limits = {
  maxEventBytes: 1024,
  maxPendingItems: 4,
  maxPendingBytes: 8192,
  maxFileBytes: 4096,
  maxFiles: 8,
};
const frame = `${JSON.stringify({
  schemaVersion: 1,
  epoch: '00000000-0000-4000-8000-000000000001',
  sequence: 1,
  event: { message: 'preserved' },
})}\n`;

test('active NUL tail preserves bytes and recovery remains visible across restarts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sk-journal-recovery-'));
  const path = join(root, 'audit.jsonl');
  const damaged = Buffer.concat([Buffer.from(frame), Buffer.alloc(839)]);
  try {
    await writeFile(path, damaged);
    const journal = await createDiagnosticJournal({ path, eventSchema, limits });
    try {
      expect(journal.getStatus()).toMatchObject({
        partialTails: 1,
        recovery: { anomalies: 1, skippedBytes: 839 },
      });
      expect(journal.submit({ message: 'new' }).outcome).toBe('accepted');
      await journal.flush();
      expect(await readFile(`${path}.1`)).toEqual(damaged);
      const rows = await Array.fromAsync(
        readDiagnosticJournal({ paths: [`${path}.1`, path], eventSchema, maxLineBytes: 4096 }),
      );
      expect(
        rows.filter((row) => row.type === 'frame').map((row) => row.frame.event.message),
      ).toEqual(['preserved', 'new']);
    } finally {
      await journal.close();
    }
    const restarted = await createDiagnosticJournal({ path, eventSchema, limits });
    try {
      expect(restarted.getStatus()).toMatchObject({
        partialTails: 0,
        recovery: { anomalies: 1, skippedBytes: 839 },
      });
    } finally {
      await restarted.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('single-file recovery refuses to erase evidence and releases its lock on failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sk-journal-single-'));
  const path = join(root, 'audit.jsonl');
  const damaged = Buffer.concat([Buffer.from(frame), Buffer.alloc(839)]);
  try {
    await writeFile(path, damaged);
    await writeFile(`${path}.1`, frame);
    await expect(
      createDiagnosticJournal({
        path,
        eventSchema,
        limits: { ...limits, maxFiles: 1 },
        onStartupRefusal: 'fail',
      }),
    ).rejects.toBeInstanceOf(DiagnosticJournalRecoveryError);
    expect(await readFile(path)).toEqual(damaged);
    expect(await readFile(`${path}.1`)).toEqual(Buffer.from(frame));
    await expect(readFile(`${path}.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
    const recovered = await createDiagnosticJournal({ path, eventSchema, limits });
    await recovered.close();
    expect(await readFile(`${path}.1`)).toEqual(damaged);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('clean active with damaged retained .1 and .7 reports every generation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sk-journal-retained-'));
  const path = join(root, 'audit.jsonl');
  try {
    await writeFile(path, frame);
    for (const index of [1, 7]) {
      await writeFile(
        `${path}.${index}`,
        Buffer.concat([Buffer.from(frame), Buffer.alloc(839)]),
      );
    }
    const journal = await createDiagnosticJournal({ path, eventSchema, limits });
    try {
      expect(journal.getStatus()).toMatchObject({
        partialTails: 0,
        recovery: { filesChecked: 3, anomalies: 2, skippedBytes: 1678 },
      });
    } finally {
      await journal.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
