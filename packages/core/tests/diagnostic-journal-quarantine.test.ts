import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createDiagnosticJournal } from '../src/application/diagnostic-journal';
import type { DiagnosticJournalStartupRefusalPolicy } from '../src/application/diagnostic-journal-contract';
import { createStartupRefusalHandler } from '../src/application/diagnostic-journal-quarantine';
import { DiagnosticJournalRecoveryError } from '../src/application/diagnostic-journal-read-contract';
import { createApplication } from '../src/application/kernel';
import { defineManagedResource } from '../src/application/resource';

const eventSchema = z.object({ message: z.string() }).strict();
const limits = {
  maxEventBytes: 1024,
  maxPendingItems: 4,
  maxPendingBytes: 8192,
  maxFileBytes: 4096,
  maxFiles: 4,
};
const frame = `${JSON.stringify({
  schemaVersion: 1,
  epoch: '00000000-0000-4000-8000-000000000001',
  sequence: 1,
  event: { message: 'preserved' },
})}\n`;
const torn = Buffer.concat([Buffer.from(frame), Buffer.alloc(839)]);

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function journalRoot() {
  const root = await mkdtemp(join(tmpdir(), 'sk-journal-quarantine-'));
  roots.push(root);
  return root;
}
const open = (path: string, onStartupRefusal?: DiagnosticJournalStartupRefusalPolicy) =>
  createDiagnosticJournal({
    path,
    eventSchema,
    limits: { ...limits, maxFiles: 1 },
    ...(onStartupRefusal && { onStartupRefusal }),
  });

test('a torn single-slot file is quarantined by default and the journal starts', async () => {
  const root = await journalRoot();
  const path = join(root, 'audit.jsonl');
  await writeFile(path, torn);
  const journal = await open(path);
  const status = journal.getStatus();
  try {
    const moved = status.recovery?.quarantined?.[0];
    expect(status.recovery?.quarantined).toEqual([
      {
        file: path,
        quarantinedAs: `${path}.quarantined-${status.epoch}`,
        reason: 'torn-without-retention-slot',
      },
    ]);
    if (!moved) throw new Error('expected a quarantined file');
    expect(await readFile(moved.quarantinedAs)).toEqual(torn);
    expect(journal.submit({ message: 'after' }).outcome).toBe('accepted');
    await journal.flush();
    expect(JSON.parse(await readFile(path, 'utf8')).event).toEqual({ message: 'after' });
  } finally {
    await journal.close();
  }
  // A quarantined name is outside retention: a later open neither reads nor removes it, and
  // names it again, without a reason, until the operator removes it.
  const quarantinedAs = `${path}.quarantined-${status.epoch}`;
  const reopened = await open(path);
  await reopened.close();
  expect(reopened.getStatus().recovery).toEqual({
    filesChecked: 1,
    anomalies: 0,
    skippedBytes: 0,
    quarantined: [{ file: path, quarantinedAs }],
  });
  expect((await readdir(root)).sort()).toEqual(
    ['audit.jsonl', `audit.jsonl.quarantined-${status.epoch}`].sort(),
  );
  await rm(quarantinedAs);
  const cleared = await open(path);
  await cleared.close();
  expect(cleared.getStatus().recovery).toBeUndefined();
});

test('the status lists this open first, then earlier quarantines by name, and counts the rest', async () => {
  const root = await journalRoot();
  const path = join(root, 'audit.jsonl');
  await writeFile(path, frame);
  await mkdir(`${path}.1`);
  // Index 9 is beyond `maxFiles`: as a generation, retention would delete it.
  const earlier = Array.from(
    { length: 40 },
    (_, index) => `audit.jsonl.9.quarantined-${String(index).padStart(2, '0')}`,
  );
  const unrelated = [
    'audit.jsonlx.quarantined-a',
    'other.jsonl.quarantined-b',
    'audit.jsonl.9',
  ];
  for (const name of [...earlier, ...unrelated]) await writeFile(join(root, name), frame);

  const journal = await createDiagnosticJournal({ path, eventSchema, limits });
  const { epoch, recovery } = journal.getStatus();
  await journal.close();
  expect(recovery?.quarantined).toHaveLength(32);
  expect(recovery?.quarantinedUnlisted).toBe(9);
  expect(recovery?.quarantined?.slice(0, 3)).toEqual([
    {
      file: `${path}.1`,
      quarantinedAs: `${path}.1.quarantined-${epoch}`,
      reason: 'not-a-regular-file',
    },
    { file: `${path}.9`, quarantinedAs: join(root, earlier[0] ?? '') },
    { file: `${path}.9`, quarantinedAs: join(root, earlier[1] ?? '') },
  ]);
  const names = await readdir(root);
  expect(earlier.every((name) => names.includes(name))).toBe(true);
  expect(names).toContain('audit.jsonlx.quarantined-a');
  expect(names).not.toContain('audit.jsonl.9');
});

test("onStartupRefusal 'fail' throws the typed refusal and moves nothing", async () => {
  const root = await journalRoot();
  const path = join(root, 'audit.jsonl');
  await writeFile(path, torn);
  const refusal = await open(path, 'fail').catch((error: unknown) => error);
  expect(refusal).toBeInstanceOf(DiagnosticJournalRecoveryError);
  if (!(refusal instanceof DiagnosticJournalRecoveryError)) return;
  expect(refusal).toMatchObject({
    reason: 'torn-without-retention-slot',
    file: path,
    quarantineFailed: false,
    recovery: { filesChecked: 1, anomalies: 1, skippedBytes: 839 },
  });
  expect(await readdir(root)).toEqual(['audit.jsonl']);
  expect(await readFile(path)).toEqual(torn);
});

test('retained names that are not regular files are quarantined, or refused under fail', async () => {
  const root = await journalRoot();
  const path = join(root, 'audit.jsonl');
  const setUp = async () => {
    await writeFile(path, frame);
    await mkdir(`${path}.2`);
    await symlink(path, `${path}.3`);
  };
  await setUp();
  const refusal = await createDiagnosticJournal({
    path,
    eventSchema,
    limits,
    onStartupRefusal: 'fail',
  }).catch((error: unknown) => error);
  expect(refusal).toMatchObject({ name: 'DiagnosticJournalRecoveryError' });
  expect(refusal).toMatchObject({ reason: 'not-a-regular-file' });
  expect((await readdir(root)).sort()).toEqual([
    'audit.jsonl',
    'audit.jsonl.2',
    'audit.jsonl.3',
  ]);

  const journal = await createDiagnosticJournal({ path, eventSchema, limits });
  const { epoch, recovery } = journal.getStatus();
  await journal.close();
  expect(
    recovery?.quarantined?.map(({ file, quarantinedAs, reason }) => ({
      file,
      quarantinedAs,
      reason,
    })),
  ).toEqual(
    [`${path}.2`, `${path}.3`].map((file) => ({
      file,
      quarantinedAs: `${file}.quarantined-${epoch}`,
      reason: 'not-a-regular-file',
    })),
  );
  // The link moved, not its target.
  expect(await readFile(path, 'utf8')).toBe(frame);
  expect(await readFile(`${path}.3.quarantined-${epoch}`, 'utf8')).toBe(frame);
});

test('an unreadable retained file is quarantined with its code, with a readable control', async () => {
  const root = await journalRoot();
  await chmod(root, 0o777);
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, 'fixtures/diagnostic-journal-open-probe.ts')],
    outdir: join(root, 'probe'),
    target: 'node',
    format: 'esm',
  });
  const probe = built.outputs[0];
  if (!built.success || !probe) throw new Error('expected the Node probe');
  const node = Bun.which('node');
  if (!node) throw new Error('Node is required to verify journal permission handling');
  const privilege = process.getuid?.() === 0 ? { uid: 65534, gid: 65534 } : {};
  const run = (path: string, policy: DiagnosticJournalStartupRefusalPolicy) => {
    const result = spawnSync(node, [probe.path, path, policy], {
      encoding: 'utf8',
      timeout: 10_000,
      ...privilege,
    });
    expect(result.stderr).toBe('');
    return z
      .looseObject({ outcome: z.enum(['started', 'refused']) })
      .parse(JSON.parse(result.stdout));
  };

  const path = join(root, 'audit.jsonl');
  await writeFile(`${path}.1`, frame, { mode: 0o644 });
  expect(run(path, 'quarantine')).toEqual({ outcome: 'started' });

  await chmod(`${path}.1`, 0);
  expect(run(path, 'fail')).toEqual({
    outcome: 'refused',
    reason: 'unreadable',
    file: `${path}.1`,
  });
  // The test's own user is the file's owner: mode 0 would refuse this read too (root is exempt).
  await chmod(`${path}.1`, 0o644);
  expect(await readFile(`${path}.1`, 'utf8')).toBe(frame);
  await chmod(`${path}.1`, 0);

  const started = z
    .object({
      outcome: z.literal('started'),
      recovery: z.object({
        filesChecked: z.number(),
        quarantined: z.array(z.record(z.string(), z.string())),
      }),
    })
    .parse(run(path, 'quarantine'));
  const [moved] = started.recovery.quarantined;
  expect(started.recovery.filesChecked).toBe(1);
  expect(moved).toMatchObject({ file: `${path}.1`, reason: 'unreadable', code: 'EACCES' });
  const quarantined = z.string().parse(moved?.quarantinedAs);
  await chmod(quarantined, 0o644);
  expect(await readFile(quarantined, 'utf8')).toBe(frame);
});

test('a failed move aside keeps the refusal and carries both errors', async () => {
  const root = await journalRoot();
  const refuse = createStartupRefusalHandler(
    'quarantine',
    '00000000-0000-4000-8000-000000000002',
  );
  const original = new Error('EACCES');
  const refusal = await refuse({
    file: join(root, 'gone', 'audit.jsonl.1'),
    reason: 'unreadable',
    cause: original,
  }).catch((error: unknown) => error);
  expect(refusal).toBeInstanceOf(DiagnosticJournalRecoveryError);
  if (!(refusal instanceof DiagnosticJournalRecoveryError)) return;
  expect(refusal.quarantineFailed).toBe(true);
  expect(refusal.cause).toBeInstanceOf(AggregateError);
  if (!(refusal.cause instanceof AggregateError)) return;
  expect(refusal.cause.errors[0]).toBe(original);
  expect(refusal.cause.errors[1]).toMatchObject({ code: 'ENOENT' });
});

test('a required journal resource starts over a damaged file and its dependants read the quarantine', async () => {
  const root = await journalRoot();
  const path = join(root, 'audit.jsonl');
  await writeFile(path, torn);
  const opened: { close(): Promise<unknown> }[] = [];
  const journal = defineManagedResource({
    id: 'journal',
    start: async ({ reportHealth }) => {
      const value = await open(path);
      opened.push(value);
      // The journal writes: it is healthy, and what it set aside is in its own status.
      reportHealth('healthy');
      return { value };
    },
    close: async () => {
      await Promise.all(opened.map((value) => value.close()));
    },
  });
  const observed: { accepted?: boolean; quarantined?: (string | undefined)[] } = {};
  const owner = defineManagedResource({
    id: 'owner',
    dependsOn: [journal],
    start: ({ use, reportHealth }) => {
      const value = use(journal);
      observed.accepted = value.submit({ message: 'owner started' }).outcome === 'accepted';
      observed.quarantined = value
        .getStatus()
        .recovery?.quarantined?.map((entry) => entry.reason);
      reportHealth('healthy');
    },
  });
  const app = createApplication({ id: 'journal-quarantine', resources: [journal, owner] });
  const snapshot = await app.start();
  try {
    expect({ ready: snapshot.ready, health: snapshot.health, ...observed }).toEqual({
      ready: true,
      health: 'healthy',
      accepted: true,
      quarantined: ['torn-without-retention-slot'],
    });
  } finally {
    await app.shutdown({ gracePeriodMs: 1_000, forceTimeoutMs: 1_000 });
  }
});
