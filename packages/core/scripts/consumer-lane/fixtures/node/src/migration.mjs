/** A v1 file opened by the packed package migrates to v2 with one honest baseline. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteAgentEventSearch } from 'stitchkit/agent-runtime';
import { packedSqlite, proof, rawDatabase } from './packed-sqlite.mjs';

const root = await mkdtemp(join(tmpdir(), 'stitchkit-packed-migration-'));
const filename = join(root, 'runtime.sqlite');
try {
  // A conversation written by this package, then wound back to schema 1 the
  // way an installed 0.85.x left it.
  const v2 = packedSqlite(filename);
  const at = '2026-09-08T00:00:00.000Z';
  const message = {
    schemaVersion: 1,
    id: 'input-1',
    conversationId: 'migrated',
    role: 'user',
    status: 'committed',
    parts: [{ type: 'text', text: 'needle from before the migration' }],
    createdAt: at,
    updatedAt: at,
  };
  await v2.handle.store.acceptInputAndAssignRun({
    idempotencyKey: 'request-1',
    input: message,
    run: {
      schemaVersion: 1,
      id: 'run-1',
      conversationId: 'migrated',
      inputMessageIds: ['input-1'],
      assistantMessageId: 'assistant-1',
      state: 'queued',
      revision: 0,
      createdAt: at,
      updatedAt: at,
    },
  });
  await v2.handle.close();
  const raw = await rawDatabase(filename);
  raw.exec(`
    DROP TABLE stitchkit_agent_runtime_events_fts;
    DROP TABLE stitchkit_agent_runtime_events;
    DROP TABLE stitchkit_agent_runtime_projections;
    DROP TABLE stitchkit_agent_runtime_spills;
    DROP TABLE stitchkit_agent_runtime_schedules;
    DROP TABLE stitchkit_agent_runtime_children;
    UPDATE stitchkit_agent_runtime_meta SET value = '1' WHERE key = 'schema_version';
  `);
  raw.close();

  const migrationStartedAt = Date.now();
  const migrated = packedSqlite(filename);
  const events = (
    await migrated.handle.store.readEvents({ conversationId: 'migrated', limit: 10 })
  ).items;
  const baseline = events[0];
  const search = createSqliteAgentEventSearch({ database: migrated.database });
  const hits = await search({ requestingConversationId: 'migrated', query: 'needle' });
  await migrated.handle.close();
  proof(
    'migration',
    events.length === 1 &&
      baseline?.kind === 'runtime/baseline' &&
      baseline.seq === 1 &&
      new Date(baseline.occurredAt).getTime() >= migrationStartedAt - 1 &&
      baseline.payload?.asOf === at &&
      hits.length === 1 &&
      hits[0].seq === 1,
    `events ${events.length}, kind ${baseline?.kind}, occurredAt ${baseline?.occurredAt}, asOf ${baseline?.payload?.asOf}, hits ${JSON.stringify(hits)}`,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
