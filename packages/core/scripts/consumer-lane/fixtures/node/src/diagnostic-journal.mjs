import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDiagnosticJournal } from 'stitchkit/application';
import { z } from 'zod';

const directory = await mkdtemp(join(tmpdir(), 'stitchkit-packed-journal-'));
try {
  const path = join(directory, 'diagnostic.jsonl');
  const journal = await createDiagnosticJournal({
    eventSchema: z.object({ kind: z.literal('packed'), runtime: z.string() }).strict(),
    path,
    limits: {
      maxEventBytes: 256,
      maxPendingItems: 4,
      maxPendingBytes: 2_048,
      maxFileBytes: 2_048,
      maxFiles: 2,
    },
  });
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
  console.log('packed diagnostic journal: ok');
} finally {
  await rm(directory, { recursive: true, force: true });
}
