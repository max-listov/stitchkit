import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDirectoryInbox } from 'stitchkit/application/directory-inbox';
import { z } from 'zod';

const root = await mkdtemp(join(tmpdir(), 'packed-programmatic-intake-'));
const identity = { source: 'client-updates', key: 'event-1' };
const schema = z.object({ text: z.string() }).strict();
const entry = { text: 'ёж' };
const bytes = new TextEncoder().encode(
  JSON.stringify({ schemaVersion: 1, identity, entry }),
).length;
const create = (directory, handle, extra = {}) =>
  createDirectoryInbox({ id: 'intake', directory, schema, handle, ...extra });
try {
  const directory = join(root, 'pending');
  const producer = create(
    directory,
    () => {
      throw new Error('producer never activated');
    },
    { maxPendingEntries: 1, maxEntryBytes: bytes },
  );
  const { value: inbox } = await producer.start();
  const result = await inbox.accept({ ...identity, entry });
  assert.equal(result.status, 'accepted');
  assert.deepEqual(JSON.parse(await readFile(join(directory, result.filename), 'utf8')), {
    schemaVersion: 1,
    identity,
    entry,
  });
  assert.equal(
    (await inbox.accept({ ...identity, entry: { text: 'x' } })).status,
    'duplicate',
  );
  await assert.rejects(
    inbox.accept({ ...identity, key: 'event-2', entry: { text: 'x' } }),
    /maxPendingEntries/,
  );
  await assert.rejects(inbox.accept({ ...identity, entry: { text: 1 } }));
  await producer.close();
  await assert.rejects(inbox.accept({ ...identity, entry }), /not accepting/);
  const seen = [];
  const consumer = create(directory, (delivery) => {
    seen.push({ identity: delivery.identity, entry: delivery.entry });
  });
  const { value: resumed } = await consumer.start();
  assert.equal(await resumed.flush(), 1);
  assert.deepEqual(seen, [{ identity, entry }]);
  assert.equal((await resumed.accept({ ...identity, entry })).status, 'duplicate');
  assert.equal(await resumed.flush(), 0);
  await consumer.close();
  const tooSmall = create(join(root, 'too-small'), () => undefined, {
    maxEntryBytes: bytes - 1,
  });
  const { value: small } = await tooSmall.start();
  await assert.rejects(small.accept({ ...identity, entry }), /maxEntryBytes/);
  assert.deepEqual(await readdir(join(root, 'too-small')), []);
  await tooSmall.close();
  console.log('packed programmatic intake: ok');
} finally {
  await rm(root, { recursive: true, force: true });
}
