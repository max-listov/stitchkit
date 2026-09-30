import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DiagnosticJournalAnomalySchema,
  DiagnosticJournalRecoveryStatusSchema,
} from 'stitchkit/application';
import {
  createDiagnosticJournal,
  readDiagnosticJournal,
} from 'stitchkit/application/diagnostic-journal';
import { z } from 'zod';

const directory = await mkdtemp(join(tmpdir(), 'stitchkit-packed-journal-'));
try {
  const path = join(directory, 'diagnostic.jsonl');
  const config = {
    eventSchema: z.object({ kind: z.literal('packed'), runtime: z.string() }).strict(),
    path,
    limits: {
      maxEventBytes: 256,
      maxPendingItems: 4,
      maxPendingBytes: 2_048,
      maxFileBytes: 2_048,
      maxFiles: 2,
    },
  };
  const journal = await createDiagnosticJournal(config);
  const accepted = journal.submit({
    kind: 'packed',
    runtime: process.versions.bun ? 'bun' : 'node',
  });
  assert.equal(accepted.outcome, 'accepted');
  assert.equal((await journal.close()).outcome, 'closed');
  const frame = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(frame.schemaVersion, 1);
  assert.equal(frame.sequence, 1);
  assert.equal(frame.event.kind, 'packed');
  assert.equal(journal.getStatus().written, 1);
  const original = await readFile(path);
  await appendFile(path, Buffer.alloc(839));
  const restarted = await createDiagnosticJournal(config);
  try {
    const recovery = DiagnosticJournalRecoveryStatusSchema.parse(
      restarted.getStatus().recovery,
    );
    assert.equal(recovery.anomalies, 1);
    assert.equal(recovery.skippedBytes, 839);
    assert.equal(
      restarted.submit({ kind: 'packed', runtime: 'recovered' }).outcome,
      'accepted',
    );
    assert.equal((await restarted.flush()).outcome, 'settled');
  } finally {
    assert.equal((await restarted.close()).outcome, 'closed');
  }
  assert.deepEqual(await readFile(`${path}.1`), Buffer.concat([original, Buffer.alloc(839)]));
  const frames = [];
  const anomalies = [];
  for await (const row of readDiagnosticJournal({
    paths: [`${path}.1`, path],
    eventSchema: config.eventSchema,
    maxLineBytes: 2048,
  })) {
    if (row.type === 'frame') frames.push(row.frame.event);
    else anomalies.push(DiagnosticJournalAnomalySchema.parse(row.anomaly));
  }
  assert.equal(frames.length, 2);
  assert.equal(frames[1].runtime, 'recovered');
  assert.deepEqual(
    anomalies.map(({ reason, skippedBytes }) => ({ reason, skippedBytes })),
    [{ reason: 'nul-byte', skippedBytes: 839 }],
  );
  const again = await createDiagnosticJournal(config);
  try {
    assert.equal(again.getStatus().recovery.anomalies, 1);
    assert.equal(again.getStatus().partialTails, 0);
  } finally {
    await again.close();
  }
  console.log('packed diagnostic journal: ok');
} finally {
  await rm(directory, { recursive: true, force: true });
}
