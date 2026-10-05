import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createDiagnosticJournal } from '../src/application/diagnostic-journal';
import { readDiagnosticJournalTails } from '../src/application/diagnostic-journal-tail';
import { readDiagnosticJournal } from '../src/entrypoints/application/diagnostic-journal';

const eventSchema = z.object({ message: z.string() }).strict();
const limits = {
  maxEventBytes: 1024,
  maxPendingItems: 4,
  maxPendingBytes: 8192,
  maxFileBytes: 4096,
  maxFiles: 8,
};
const frame = (sequence: number) =>
  `${JSON.stringify({
    schemaVersion: 1,
    epoch: '00000000-0000-4000-8000-000000000001',
    sequence,
    event: { message: `row ${sequence}` },
  })}\n`;

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function journalRoot() {
  const root = await mkdtemp(join(tmpdir(), 'sk-journal-scan-'));
  roots.push(root);
  return root;
}

test('startupScan tails reports a torn retained generation, full also reports a damaged row in the middle', async () => {
  const root = await journalRoot();
  const path = join(root, 'audit.jsonl');
  await writeFile(path, frame(9));
  // .1 is damaged in the middle only; .2 is torn at its end only.
  await writeFile(`${path}.1`, `${frame(1)}not json at all\n${frame(3)}`);
  await writeFile(`${path}.2`, `${frame(4)}${frame(5)}{"schemaVersion":1,"epo`);
  const status = async (startupScan?: 'tails' | 'full') => {
    const journal = await createDiagnosticJournal({
      path,
      eventSchema,
      limits,
      ...(startupScan && { startupScan }),
    });
    try {
      return journal.getStatus().recovery;
    } finally {
      await journal.close();
    }
  };
  const tails = await status();
  expect(tails).toMatchObject({ filesChecked: 3, anomalies: 1 });
  expect(tails?.firstAnomaly).toMatchObject({
    file: `${path}.2`,
    line: 3,
    reason: 'unterminated-line',
    position: 'tail',
    terminated: false,
  });
  expect(await status('tails')).toEqual(tails);
  const full = await status('full');
  expect(full).toMatchObject({ filesChecked: 3, anomalies: 2 });
  expect(full?.firstAnomaly).toMatchObject({ file: `${path}.2`, position: 'tail' });
  expect(full?.lastAnomaly).toMatchObject({
    file: `${path}.1`,
    line: 2,
    position: 'interior',
  });
  await expect(
    createDiagnosticJournal({
      path,
      eventSchema,
      limits,
      // @ts-expect-error only the two declared scans are accepted
      startupScan: 'head',
    }),
  ).rejects.toThrow();
});

test('the tail reader reports exactly what the full reader reports for the final line', async () => {
  const root = await journalRoot();
  const cases: Record<string, Buffer> = {
    empty: Buffer.alloc(0),
    clean: Buffer.from(frame(1) + frame(2)),
    'valid but unterminated': Buffer.from(frame(1) + frame(2).trimEnd()),
    'nul tail': Buffer.concat([Buffer.from(frame(1)), Buffer.alloc(40)]),
    'invalid utf8': Buffer.concat([Buffer.from(frame(1)), Buffer.from([0xff, 0xfe, 0x0a])]),
    'bad terminated json': Buffer.from(`${frame(1)}{nope}\n`),
    'only a line feed': Buffer.from('\n'),
    'oversized unterminated': Buffer.from(frame(1) + 'a'.repeat(5000)),
    'frame without event': Buffer.from(`${frame(1)}{"schemaVersion":1}\n`),
  };
  for (const [label, bytes] of Object.entries(cases)) {
    const file = join(root, `${label.replaceAll(' ', '-')}.jsonl`);
    await writeFile(file, bytes);
    const full = await Array.fromAsync(
      readDiagnosticJournal({ paths: [file], eventSchema: z.json(), maxLineBytes: 4096 }),
    );
    const tails = await Array.fromAsync(readDiagnosticJournalTails([file], 4096));
    // The tail reader's rows are the full reader's rows about the last line of the file.
    const lastLine = Math.max(
      0,
      ...full.map((row) => (row.type === 'anomaly' ? row.anomaly.line : row.line)),
    );
    const expected = full.filter(
      (row) => (row.type === 'anomaly' ? row.anomaly.line : row.line) === lastLine,
    );
    expect([label, tails]).toEqual([label, expected]);
  }
});
