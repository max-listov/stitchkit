import { expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { link, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createDirectoryInbox } from '../src/application/directory-inbox';
import {
  clock,
  identity,
  inboxDirectory,
  openInbox,
  removeInboxDirectoriesAfterEach,
} from './application-directory-inbox-fixture';

removeInboxDirectoriesAfterEach();

const good = JSON.stringify({ text: 'ok' });

test('a reused rejected filename is set aside under its content name and never blocks the pass', async () => {
  const dir = await inboxDirectory();
  const seen: string[] = [];
  const { inbox } = await openInbox(dir, ({ entry }) => {
    seen.push(entry.text);
  });
  await writeFile(join(dir, 'job.json'), 'not json');
  expect(await inbox.flush()).toBe(0);
  expect(await readdir(join(dir, 'rejected'))).toEqual(['job.json']);

  // The producer drops different bytes under the rejected name, and a valid entry that sorts after it.
  await writeFile(join(dir, 'job.json'), 'still not json');
  await writeFile(join(dir, 'z-good.json'), good);
  expect(await inbox.flush()).toBe(1);
  expect(seen).toEqual(['ok']);
  const aside = (await readdir(join(dir, 'rejected'))).sort();
  expect(aside).toHaveLength(2);
  expect(aside[0]).toBe('job.json');
  expect(aside[1]).toMatch(/^job\.json\.[0-9a-f]{16}$/);
  expect(await readFile(join(dir, 'rejected', 'job.json'), 'utf8')).toBe('not json');
  expect(await readFile(join(dir, 'rejected', aside[1] ?? ''), 'utf8')).toBe('still not json');
  expect((await readdir(dir)).filter((name) => /^[^.].*\.json$/.test(name))).toEqual([]);

  // The same bytes again, under either name, are an entry already set aside: removed, nothing new kept.
  for (const again of ['not json', 'still not json']) {
    await writeFile(join(dir, 'job.json'), again);
    expect(await inbox.flush()).toBe(0);
    expect(await readdir(join(dir, 'rejected'))).toHaveLength(2);
    expect(await readdir(dir)).not.toContain('job.json');
  }
});

test('a hard-linked entry is rejected with its reason and the next entry is delivered', async () => {
  const dir = await inboxDirectory();
  const elsewhere = await mkdtemp(join(tmpdir(), 'stitchkit-intake-link-'));
  try {
    const seen: string[] = [];
    const rejected: string[] = [];
    const { inbox } = await openInbox(
      dir,
      ({ key }) => {
        seen.push(key);
      },
      {
        onRejected: (rejection) => void rejected.push(`${rejection.key}:${rejection.detail}`),
      },
    );
    await writeFile(join(dir, 'a-hard.json'), good);
    await link(join(dir, 'a-hard.json'), join(elsewhere, 'alias.json'));
    await writeFile(join(dir, 'plain.json'), good);
    expect(await inbox.flush()).toBe(1);
    expect(seen).toEqual(['plain.json']);
    expect(rejected).toEqual(['a-hard.json:managed file has multiple links']);
    const state = await inbox.state();
    expect(state.claims).toEqual([]);
    expect(state.rejected.map((item) => [item.key, item.reason])).toEqual([
      ['a-hard.json', 'invalid'],
    ]);
    expect(await readdir(join(dir, 'rejected'))).toEqual(['a-hard.json']);
    expect(await readFile(join(elsewhere, 'alias.json'), 'utf8')).toBe(good);
  } finally {
    await rm(elsewhere, { recursive: true, force: true });
  }
});

test('an entry whose file cannot be set aside is reported and the rest of the pass still runs', async () => {
  const dir = await inboxDirectory();
  const failures: unknown[] = [];
  const seen: string[] = [];
  const { inbox } = await openInbox(
    dir,
    ({ key }) => {
      seen.push(key);
    },
    { onError: (error) => void failures.push(error) },
  );
  // `rejected` is a file, so setting an entry aside fails for that entry alone.
  await writeFile(join(dir, 'rejected'), 'occupied');
  await writeFile(join(dir, 'a-bad.json'), 'not json');
  await writeFile(join(dir, 'z-good.json'), good);
  expect(await inbox.flush()).toBe(1);
  expect(seen).toEqual(['z-good.json']);
  expect(failures).toHaveLength(1);
  expect(failures[0]).toBeInstanceOf(Error);
});

test('an entry that cannot be read is released for a later attempt, not thrown out of the pass', async () => {
  const dir = await inboxDirectory();
  const time = clock();
  let swapped = false;
  let swap = false;
  const failures: unknown[] = [];
  const { inbox } = await openInbox(dir, () => undefined, {
    clock: () => {
      if (swap && !swapped) {
        swapped = true;
        rmSync(join(dir, 'a-changed.json'));
        mkdirSync(join(dir, 'a-changed.json'));
      }
      return time.now();
    },
    onError: (error) => void failures.push(error),
  });
  await writeFile(join(dir, 'a-changed.json'), good);
  await writeFile(join(dir, 'z-good.json'), good);
  swap = true;
  // The first entry becomes a directory between the listing and the read.
  expect(await inbox.flush()).toBe(1);
  const state = await inbox.state();
  expect(state.claims.map((claim) => [claim.key, claim.attempts, claim.leaseId])).toEqual([
    ['a-changed.json', 1, null],
  ]);
  expect(failures).toHaveLength(1);
  expect(String(failures[0])).toContain('not a regular file');
});

test('accept stores the schema input, so a transforming schema delivers what it accepted', async () => {
  const dir = await inboxDirectory();
  const Amount = z.object({ amount: z.string().transform(Number) }).strict();
  const delivered: unknown[] = [];
  const resource = createDirectoryInbox({
    id: 'amount',
    directory: dir,
    schema: Amount,
    handle: ({ entry }) => void delivered.push(entry),
  });
  const { value: inbox } = await resource.start();
  const accepted = await inbox.accept({ ...identity, entry: { amount: '42' } });
  expect(accepted.status).toBe('accepted');
  expect(JSON.parse(await readFile(join(dir, accepted.filename), 'utf8')).entry).toEqual({
    amount: '42',
  });
  const asOutput: Parameters<typeof inbox.accept>[0] = {
    ...identity,
    key: 'two',
    // @ts-expect-error accept takes the schema's input type: the output of a transform is refused statically
    entry: { amount: 42 },
  };
  await expect(inbox.accept(asOutput)).rejects.toThrow();
  expect(await inbox.flush()).toBe(1);
  expect(delivered).toEqual([{ amount: 42 }]);
  expect((await inbox.state()).rejected).toEqual([]);
});
