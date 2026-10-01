import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withExclusiveLock, writeFileAtomic } from 'stitchkit/files';
import { createLocalStepDurability } from 'stitchkit/tools';

async function missingJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}
const [mode, rootArg, id] = process.argv.slice(2);
if (mode === 'worker') {
  const root = rootArg;
  const ledgerPath = join(root, 'ledger');
  await writeFile(join(root, `ready-${id}`), 'ready');
  for (let count = 0; ; count++) {
    try {
      await stat(join(root, 'start'));
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (count > 1000) throw new Error('start barrier timed out');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  await withExclusiveLock(
    join(root, 'lease'),
    async () => {
      const store = {
        async appendEvent(input) {
          const rows = await missingJson(ledgerPath, []);
          const row = {
            ...input,
            schemaVersion: 1,
            eventId: `e${rows.length + 1}`,
            seq: rows.length + 1,
            occurredAt: new Date().toISOString(),
          };
          rows.push(row);
          await writeFileAtomic(ledgerPath, JSON.stringify(rows), { durability: 'directory' });
          return row;
        },
        async readEvents(input) {
          const rows = await missingJson(ledgerPath, []);
          return { items: rows.filter((row) => row.seq >= (input.fromSeq ?? 1)) };
        },
      };
      const engine = createLocalStepDurability({ store, conversationId: 'c', runId: 'r' });
      const result = await engine.effect('send', {
        async run() {
          const rows = await missingJson(ledgerPath, []);
          assert.equal(rows[0].payload.phase, 'intent');
          const sent = await missingJson(join(root, 'sends'), []);
          sent.push({ id: 'receipt-1' });
          await writeFile(join(root, 'sends'), JSON.stringify(sent));
          await new Promise((resolve) => setTimeout(resolve, 20));
          return { id: 'receipt-1' };
        },
        reconcile: () => ({ id: 'receipt-1' }),
      });
      assert.deepEqual(result, { outcome: 'accepted', proof: { id: 'receipt-1' } });
    },
    { timeoutMs: 3000 },
  );
} else {
  const root = await mkdtemp(join(tmpdir(), 'packed-effect-lease-'));
  const children = [];
  try {
    const done = [];
    for (const id of ['a', 'b']) {
      const child = spawn(
        process.execPath,
        [fileURLToPath(import.meta.url), 'worker', root, id],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      children.push(child);
      let error = '';
      child.stderr.on('data', (bytes) => {
        error += bytes.toString();
      });
      done.push(
        new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('close', (code) =>
            code === 0 ? resolve() : reject(new Error(`worker ${id}: ${code}: ${error}`)),
          );
        }),
      );
    }
    for (let count = 0; ; count++) {
      try {
        await stat(join(root, 'ready-a'));
        await stat(join(root, 'ready-b'));
        break;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (count > 1000) throw new Error('worker readiness timed out');
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    await writeFile(join(root, 'start'), 'start');
    await Promise.all(done);
    assert.equal((await missingJson(join(root, 'sends'), [])).length, 1);
    assert.equal(
      (await missingJson(join(root, 'ledger'), [])).filter(
        (row) => row.payload.phase === 'intent',
      ).length,
      1,
    );
    console.log('packed effect external lease two-process: ok');
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
  }
}
