import { assertPositiveSafeInteger } from '../internal/positive-integer';
import type { PostgresQuery } from '../internal/postgres-query';
import { type AgentCompanionHost, createCompanionHost } from './companion-host';
import type { AgentConversationReader } from './conversations';
import { checkedPostgresPrefix, initializePostgresAgentStore } from './postgres-schema';
import {
  isRetryablePostgresConflict,
  POSTGRES_ISOLATION,
  type PostgresTransactionRunner,
  postgresSession,
  runPostgresTransaction,
} from './postgres-transactions';
import { sqlArchive, sqlEvents } from './sql-events';
import { sqlHistory } from './sql-history';
import { sqlLedger } from './sql-ledger';
import { conversationTables, sqlConversationPurge } from './sql-purge';
import {
  type AgentSqlRead,
  listSqlConversations,
  pageSqlConversationMessages,
  scanSqlRecoverable,
} from './sql-reads';
import { CountRowSchema, type SqlStoreDriver } from './sql-rows';
import { type AgentSqlDialect, type AgentSqlSession, agentSqlTables } from './sql-session';
import { createAgentRuntimeStore } from './store-create';
import type { AgentRuntimeStoreDriver } from './store-driver-contract';

/** Configuration for constructing a Postgres-backed agent runtime store. */
export interface PostgresAgentRuntimeStoreConfig<TX> {
  /**
   * Open a new transaction: commit when `work` resolves, roll back when it
   * throws. The store runs the first statement in it — its isolation level —
   * and runs `work` again when Postgres reports a serialization conflict, so
   * this must open a fresh transaction every call, never join one already open.
   *
   * - Bun: `(work) => sql.begin(work)`
   * - Prisma: `(work) => prisma.$transaction(work)`
   */
  transaction<RESULT>(work: (tx: TX) => Promise<RESULT>): Promise<RESULT>;
  /** Run one statement with `$1…$n` parameters in `tx`; resolve with its rows. */
  query: PostgresQuery<TX>;
  /** Table name prefix: `<prefix>_runs`, `<prefix>_events`, … Default `stitchkit_agent_runtime`. */
  prefix?: string;
  /**
   * Create the schema on first use when it is missing. Default `true`; set
   * `false` when migrations own the schema — `postgresAgentRuntimeStoreDdl`
   * is the text. Either way the version is checked before the first operation.
   */
  createTables?: boolean;
  /** Attempts of one transaction before a serialization conflict surfaces. Default 32. */
  maxAttempts?: number;
}

/** Postgres-backed agent runtime store, conversation reader, and companion host bundle. */
export interface PostgresAgentRuntimeStore {
  store: ReturnType<typeof createAgentRuntimeStore>;
  conversations: AgentConversationReader;
  /** Where the companions keep their rows; the same host the SQLite store gives. */
  host: AgentCompanionHost;
}

function postgresDialect(prefix: string): AgentSqlDialect {
  const tables = agentSqlTables(prefix);
  return {
    name: 'postgres',
    tables,
    conversationTables: [
      ...conversationTables(tables),
      tables.eventSeq,
      tables.eventSearch,
      tables.eventSearchState,
    ],
    messageRowId: 'row_id',
    contains: (column) => `strpos(${column}, ?) > 0`,
    async nextEventSeq(session, conversationId) {
      // One counter row per conversation, advanced in place. Its row lock is
      // what orders two writers: the second waits, and under SERIALIZABLE
      // fails and is retried, instead of both reading the same MAX(seq).
      const row = await session.get(
        `INSERT INTO ${tables.eventSeq} (conversation_id, last_seq) VALUES (?, 1)
         ON CONFLICT (conversation_id) DO UPDATE SET last_seq = ${tables.eventSeq}.last_seq + 1
         RETURNING last_seq AS count`,
        [conversationId],
      );
      return CountRowSchema.parse(row).count;
    },
  };
}

/**
 * The driver, its dialect and its read transaction.
 *
 * `testing` replaces the retry recognizer or the isolation statement — the
 * two levers a control pulls to prove they hold the store together. Only a
 * test passes it; the public factories below never do.
 */
export function buildPostgresAgentStore<TX>(
  config: PostgresAgentRuntimeStoreConfig<TX>,
  testing?: Partial<Pick<PostgresTransactionRunner<TX>, 'isRetryable' | 'isolation'>>,
): { driver: SqlStoreDriver; dialect: AgentSqlDialect; read: AgentSqlRead } {
  const prefix = checkedPostgresPrefix(config.prefix ?? 'stitchkit_agent_runtime');
  // `attempt >= NaN` is never true: an unchecked count retries a conflict forever.
  assertPositiveSafeInteger('maxAttempts', config.maxAttempts);
  const dialect = postgresDialect(prefix);
  const runner: PostgresTransactionRunner<TX> = {
    transaction: (work) => config.transaction(work),
    query: config.query,
    maxAttempts: config.maxAttempts ?? 32,
    isRetryable: testing?.isRetryable ?? isRetryablePostgresConflict,
    isolation: testing?.isolation ?? POSTGRES_ISOLATION,
  };
  // The schema is checked once, before the first operation, and every
  // operation waits for that check; a failed check is retried by the next
  // operation instead of being remembered.
  let ready: Promise<void> | undefined;
  const ensureSchema = (): Promise<void> => {
    ready ??= config
      .transaction((tx) =>
        initializePostgresAgentStore(
          postgresSession(config.query, tx),
          prefix,
          config.createTables ?? true,
        ),
      )
      .catch((error: unknown) => {
        ready = undefined;
        throw error;
      });
    return ready;
  };
  const transaction: SqlStoreDriver['transaction'] = async (work, options) => {
    await ensureSchema();
    return runPostgresTransaction(runner, options?.access ?? 'write', work);
  };
  const read: AgentSqlRead = (work) => transaction(work, { access: 'read' });
  const driver: SqlStoreDriver = {
    conversations: sqlConversationPurge(dialect),
    transaction,
    ...sqlLedger(dialect),
    history: sqlHistory(dialect),
    events: sqlEvents(dialect),
    archive: sqlArchive(dialect),
    scanRecoverable: (input) => scanSqlRecoverable(dialect, read, input),
  };
  return { driver, dialect, read };
}

/**
 * The normalized driver over Postgres, for a caller who wraps or extends it
 * before building a store with `createAgentRuntimeStore`.
 * `createPostgresAgentRuntimeStore` is that assembly, plus the companion host.
 */
export function createPostgresAgentRuntimeStoreDriver<TX>(
  config: PostgresAgentRuntimeStoreConfig<TX>,
): AgentRuntimeStoreDriver<AgentSqlSession> {
  return buildPostgresAgentStore(config).driver;
}

/**
 * The agent store on Postgres, in transactions the store opens through the
 * application's client.
 *
 * Unlike the sync store, which writes inside the application's transaction
 * so a change commits with the application's own rows, this store owns its
 * transactions: it runs them SERIALIZABLE and retries a serialization
 * conflict by running the whole unit again, which only the code that opened
 * the transaction can do. Retrying is the driver's duty; a caller-side
 * retry of a whole store call does not replace it.
 */
export function createPostgresAgentRuntimeStore<TX>(
  config: PostgresAgentRuntimeStoreConfig<TX>,
): PostgresAgentRuntimeStore {
  const { driver, dialect, read } = buildPostgresAgentStore(config);
  return {
    store: createAgentRuntimeStore(driver),
    host: createCompanionHost({ dialect, driver }),
    conversations: {
      list: (input) => listSqlConversations(dialect, read, input),
      messages: (input) => pageSqlConversationMessages(dialect, read, input),
    },
  };
}
