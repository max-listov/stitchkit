import { createHash } from 'node:crypto';
import { z } from 'zod';
import { setPostgresTransactionIsolation } from './postgres-transactions';
import { conversationTables } from './sql-purge';
import { type AgentSqlSession, type AgentSqlTables, agentSqlTables } from './sql-session';

export const POSTGRES_AGENT_STORE_SCHEMA_VERSION = 1;

/** The longest name built from the prefix: `<prefix>_event_search_document`. */
const LONGEST_SUFFIX = '_event_search_document';
const PREFIX = /^[a-z_][a-z0-9_]*$/;

/**
 * A prefix every table and index name it builds can carry.
 *
 * Postgres truncates an identifier past 63 bytes without a word, so two
 * prefixes that differ only past that point would silently share tables.
 * Lowercase only: an unquoted identifier folds to lowercase, and a prefix
 * that reads one way in the configuration and another in `psql` invites a
 * second schema.
 */
export function checkedPostgresPrefix(prefix: string): string {
  if (!PREFIX.test(prefix)) {
    throw new TypeError(
      `[stitchkit] agent store: a table prefix is [a-z_][a-z0-9_]*, received ${JSON.stringify(prefix)}`,
    );
  }
  const longest = Buffer.byteLength(`${prefix}${LONGEST_SUFFIX}`);
  if (longest > 63) {
    throw new TypeError(
      `[stitchkit] agent store: the prefix ${JSON.stringify(prefix)} makes a ${longest}-byte table name; Postgres keeps 63`,
    );
  }
  return prefix;
}

const ID = 'TEXT COLLATE "C" NOT NULL';
const TEXT = 'TEXT COLLATE "C"';

/**
 * The tables and indexes of schema version 1, for a migration. Safe to run twice.
 *
 * Identifiers and timestamps are `TEXT COLLATE "C"`: ids compare byte for
 * byte, as they do in SQLite and in the archive, and ISO timestamps keep the
 * offset they were written with, so an export reads back the bytes it took.
 * Payloads are JSON text, spills `bytea`, counters `integer`.
 */
export function postgresAgentRuntimeStoreDdl(prefix = 'stitchkit_agent_runtime'): string {
  const p = checkedPostgresPrefix(prefix);
  const t = agentSqlTables(p);
  return `
CREATE TABLE IF NOT EXISTS ${t.meta} (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ${t.heads} (
  conversation_id ${ID} PRIMARY KEY,
  version integer NOT NULL CHECK (version >= 0)
);
CREATE TABLE IF NOT EXISTS ${t.runs} (
  conversation_id ${ID},
  run_id ${ID},
  assistant_message_id ${ID},
  state ${TEXT} NOT NULL,
  created_at ${TEXT} NOT NULL,
  payload TEXT NOT NULL,
  terminal_assistant_payload TEXT,
  PRIMARY KEY (conversation_id, run_id),
  UNIQUE (conversation_id, assistant_message_id)
);
CREATE INDEX IF NOT EXISTS ${p}_runs_recoverable ON ${t.runs} (state, conversation_id, run_id);
CREATE TABLE IF NOT EXISTS ${t.admissions} (
  conversation_id ${ID},
  idempotency_key ${ID},
  input_message_id ${ID},
  run_id ${ID},
  assistant_message_id ${ID},
  input_payload TEXT NOT NULL,
  PRIMARY KEY (conversation_id, idempotency_key),
  UNIQUE (conversation_id, input_message_id)
);
CREATE TABLE IF NOT EXISTS ${t.messages} (
  row_id bigint GENERATED ALWAYS AS IDENTITY,
  conversation_id ${ID},
  id ${ID},
  position integer NOT NULL CHECK (position >= 0),
  active integer NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  payload TEXT NOT NULL,
  PRIMARY KEY (conversation_id, id)
);
CREATE INDEX IF NOT EXISTS ${p}_messages_page ON ${t.messages} (conversation_id, position, row_id);
CREATE TABLE IF NOT EXISTS ${t.seeds} (
  conversation_id ${ID},
  seed_key ${ID},
  message_ids TEXT NOT NULL,
  created_at ${TEXT} NOT NULL,
  PRIMARY KEY (conversation_id, seed_key)
);
CREATE TABLE IF NOT EXISTS ${t.events} (
  row_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id ${ID},
  seq integer NOT NULL CHECK (seq > 0),
  event_id ${ID} UNIQUE,
  schema_version integer NOT NULL CHECK (schema_version > 0),
  kind ${TEXT} NOT NULL,
  occurred_at ${TEXT} NOT NULL,
  ignorable integer NOT NULL DEFAULT 0 CHECK (ignorable IN (0, 1)),
  payload TEXT NOT NULL,
  UNIQUE (conversation_id, seq)
);
CREATE INDEX IF NOT EXISTS ${p}_events_time ON ${t.events} (conversation_id, occurred_at, seq);
CREATE TABLE IF NOT EXISTS ${t.eventSeq} (
  conversation_id ${ID} PRIMARY KEY,
  last_seq integer NOT NULL CHECK (last_seq > 0)
);
CREATE TABLE IF NOT EXISTS ${t.projections} (
  conversation_id ${ID},
  name ${ID},
  version integer NOT NULL CHECK (version > 0),
  upto_seq integer NOT NULL CHECK (upto_seq >= 0),
  payload TEXT NOT NULL,
  updated_at ${TEXT} NOT NULL,
  PRIMARY KEY (conversation_id, name)
);
CREATE INDEX IF NOT EXISTS ${p}_projection_updates ON ${t.projections} (name, updated_at, conversation_id);
CREATE TABLE IF NOT EXISTS ${t.spills} (
  reference_id ${ID} PRIMARY KEY,
  conversation_id ${ID},
  run_id ${TEXT},
  tool_call_id ${TEXT},
  media_type TEXT NOT NULL,
  bytes integer NOT NULL CHECK (bytes >= 0),
  sha256 TEXT NOT NULL,
  created_at ${TEXT} NOT NULL,
  expires_at ${TEXT},
  authorization_payload TEXT,
  payload bytea NOT NULL
);
CREATE INDEX IF NOT EXISTS ${p}_spills_owner ON ${t.spills} (conversation_id, created_at);
CREATE TABLE IF NOT EXISTS ${t.schedules} (
  id ${ID} PRIMARY KEY,
  conversation_id ${ID},
  kind ${TEXT} NOT NULL,
  next_at ${TEXT} NOT NULL,
  interval_ms bigint,
  time_zone TEXT,
  input_payload TEXT NOT NULL,
  state ${TEXT} NOT NULL,
  occurrence integer NOT NULL DEFAULT 0 CHECK (occurrence >= 0),
  claim_owner ${TEXT},
  claim_until ${TEXT},
  created_at ${TEXT} NOT NULL,
  updated_at ${TEXT} NOT NULL,
  retry_at ${TEXT},
  attempts integer NOT NULL DEFAULT 0,
  last_error TEXT,
  eligible_at ${TEXT} GENERATED ALWAYS AS (
    GREATEST(next_at, COALESCE(retry_at, next_at), COALESCE(claim_until, next_at))
  ) STORED
);
CREATE INDEX IF NOT EXISTS ${p}_schedules_due ON ${t.schedules} (eligible_at, id) WHERE state = 'scheduled';
CREATE TABLE IF NOT EXISTS ${t.children} (
  parent_conversation_id ${ID},
  child_conversation_id ${ID} UNIQUE,
  seed_upto_seq integer,
  state ${TEXT} NOT NULL,
  budget_payload TEXT NOT NULL,
  usage_payload TEXT NOT NULL,
  result_reference TEXT,
  created_at ${TEXT} NOT NULL,
  updated_at ${TEXT} NOT NULL,
  PRIMARY KEY (parent_conversation_id, child_conversation_id)
);
CREATE TABLE IF NOT EXISTS ${t.purged} (conversation_id ${ID} PRIMARY KEY);
CREATE TABLE IF NOT EXISTS ${t.eventSearch} (
  conversation_id ${ID},
  seq integer NOT NULL,
  occurred_at ${TEXT} NOT NULL,
  body TEXT NOT NULL,
  document tsvector NOT NULL,
  PRIMARY KEY (conversation_id, seq)
);
CREATE INDEX IF NOT EXISTS ${p}_event_search_document ON ${t.eventSearch} USING GIN (document);
CREATE INDEX IF NOT EXISTS ${p}_event_search_recent ON ${t.eventSearch} (conversation_id, occurred_at DESC, seq DESC);
CREATE TABLE IF NOT EXISTS ${t.eventSearchState} (
  conversation_id ${ID} PRIMARY KEY,
  indexed_seq integer NOT NULL CHECK (indexed_seq >= 0)
);
INSERT INTO ${t.meta} (key, value) VALUES ('schema_version', '${POSTGRES_AGENT_STORE_SCHEMA_VERSION}') ON CONFLICT (key) DO NOTHING;
`;
}

/** Every table of the version-1 schema; a store that finds only some of them refuses. */
export function postgresAgentStoreTables(tables: AgentSqlTables): string[] {
  return [
    tables.meta,
    ...conversationTables(tables),
    tables.eventSeq,
    tables.eventSearch,
    tables.eventSearchState,
    tables.children,
    tables.purged,
  ].sort();
}

/** Two 32-bit advisory lock keys for one prefix, so stores under different prefixes never wait on each other. */
function schemaLockKeys(prefix: string): [number, number] {
  const digest = createHash('sha256').update(`stitchkit-agent-store:${prefix}`).digest();
  return [digest.readInt32BE(0), digest.readInt32BE(4)];
}

const TableRowSchema = z.object({ tablename: z.string() });
const VersionRowSchema = z.object({ value: z.string() });

/**
 * Create the schema under a transaction-scoped advisory lock, or check it.
 *
 * Two processes starting at once both see no tables; the lock makes the
 * second wait, and once it holds the lock its statements see the first's
 * committed tables, so it checks them instead of creating them again. A
 * schema of another version, or one with tables missing, is refused rather
 * than repaired: a half-made schema is evidence, not a starting point.
 */
export async function initializePostgresAgentStore(
  session: AgentSqlSession,
  prefix: string,
  createTables: boolean,
): Promise<void> {
  const checked = checkedPostgresPrefix(prefix);
  const tables = agentSqlTables(checked);
  const [high, low] = schemaLockKeys(checked);
  // Run in READ COMMITTED even when the database defaults to SERIALIZABLE or
  // REPEATABLE READ, so a process waking from the advisory lock takes a fresh
  // snapshot and sees the tables the first process just committed.
  await setPostgresTransactionIsolation(
    session,
    'SET TRANSACTION ISOLATION LEVEL READ COMMITTED',
  );
  // The lock function returns `void`, a column type some clients cannot read
  // back (Prisma refuses the row), so it is called in FROM and the statement
  // returns an ordinary integer.
  await session.run('SELECT 1 AS locked FROM pg_advisory_xact_lock(?::int, ?::int)', [
    high,
    low,
  ]);
  const expected = postgresAgentStoreTables(tables);
  const present = (
    await session.all(
      'SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND tablename = ANY(?::text[])',
      [`{${expected.join(',')}}`],
    )
  ).map((row) => TableRowSchema.parse(row).tablename);
  if (present.length === 0) {
    if (!createTables) {
      throw new Error(
        `The Postgres agent store has no schema under prefix "${checked}" and createTables is false; run postgresAgentRuntimeStoreDdl("${checked}") in a migration`,
      );
    }
    for (const statement of postgresAgentRuntimeStoreDdl(checked).split(';\n')) {
      if (statement.trim().length > 0) await session.run(statement);
    }
    return;
  }
  if (!present.includes(tables.meta)) {
    throw new Error(
      `Refusing an unversioned partial Stitchkit agent store schema under prefix "${checked}"`,
    );
  }
  const versionRow = await session.get(
    `SELECT value FROM ${tables.meta} WHERE key = 'schema_version'`,
  );
  const version =
    versionRow === undefined ? undefined : Number(VersionRowSchema.parse(versionRow).value);
  if (version !== POSTGRES_AGENT_STORE_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported Stitchkit agent store schema version ${version ?? 'none'} under prefix "${checked}"; expected ${POSTGRES_AGENT_STORE_SCHEMA_VERSION}`,
    );
  }
  const missingTables = expected.filter((table) => !present.includes(table));
  if (missingTables.length > 0) {
    throw new Error(
      `Refusing a partial Stitchkit agent store schema under prefix "${checked}"; missing ${missingTables.join(', ')}`,
    );
  }
}
