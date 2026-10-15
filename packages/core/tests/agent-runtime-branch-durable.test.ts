import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBunSqliteAgentRuntimeStore } from '../src/agent-runtime/sqlite-bun';
import { branch, branchTurn } from './support/agent-branch-fixture';
import { reapAfterEachTest, trackPidFile } from './support/process-reaper';

reapAfterEachTest();

test('process death after lineage insertion rolls back the entire branch, then retry and reopen return one durable receipt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stitchkit-branch-crash-'));
  const filename = join(root, 'state.sqlite');
  const pidFile = join(root, 'child.pid');
  try {
    const seed = createBunSqliteAgentRuntimeStore({ filename });
    await branchTurn(seed.store, 'source', 'first');
    const before = await seed.store.exportConversation('source');
    await seed.close();
    trackPidFile(pidFile);
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, 'fixtures/branch-crash.ts'), filename, pidFile],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect({ code, error }).toEqual({ code: 77, error: '' });
    const recovered = createBunSqliteAgentRuntimeStore({ filename });
    const request = {
      requestKey: 'crash',
      destinationConversationId: 'copy',
      source: { kind: 'conversation', conversationId: 'source' },
    } satisfies Parameters<typeof branch>[1];
    try {
      expect(
        (await recovered.store.readEvents({ conversationId: 'copy', limit: 10 })).items,
      ).toHaveLength(0);
      expect((await recovered.store.loadSnapshot('copy')).version).toBe(0);
      expect(await recovered.store.exportConversation('source')).toEqual(before);
      const created = await branch(recovered.store, request);
      expect(created.outcome).toBe('created');
      await recovered.close();
      const reopened = createBunSqliteAgentRuntimeStore({ filename });
      try {
        const duplicate = await branch(reopened.store, request);
        expect(duplicate).toEqual({ outcome: 'duplicate', receipt: created.receipt });
        expect((await reopened.store.loadSnapshot('copy')).messages).toHaveLength(2);
        expect(
          (
            await reopened.store.readEvents({ conversationId: 'copy', limit: 10 })
          ).items.filter((event) => event.kind === 'runtime/branched'),
        ).toHaveLength(1);
      } finally {
        await reopened.close();
      }
    } finally {
      await recovered.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);

test('an occupied companion and a purged identity are refused without changing their bytes', async () => {
  const sqlite = createBunSqliteAgentRuntimeStore({ filename: ':memory:' });
  try {
    await branchTurn(sqlite.store, 'source', 'first');
    sqlite.database
      .prepare(`INSERT INTO stitchkit_agent_runtime_projections
      (conversation_id, name, version, upto_seq, payload, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('occupied', 'unrelated', 1, 0, '{}', '2026-10-15T00:00:00.000Z');
    await expect(
      branch(sqlite.store, {
        requestKey: 'occupied',
        destinationConversationId: 'occupied',
        source: { kind: 'conversation', conversationId: 'source' },
      }),
    ).rejects.toThrow('empty');
    await sqlite.store.purgeConversation?.({ conversationId: 'purged' });
    await expect(
      branch(sqlite.store, {
        requestKey: 'purged',
        destinationConversationId: 'purged',
        source: { kind: 'conversation', conversationId: 'source' },
      }),
    ).rejects.toThrow('purged');
    expect(
      (await sqlite.store.readEvents({ conversationId: 'occupied', limit: 10 })).items,
    ).toHaveLength(0);
    expect(
      (await sqlite.store.readEvents({ conversationId: 'purged', limit: 10 })).items,
    ).toHaveLength(0);
  } finally {
    await sqlite.close();
  }
});
