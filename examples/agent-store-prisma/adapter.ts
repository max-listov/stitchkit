import { PrismaPg } from '@prisma/adapter-pg';
import { createAgentRuntimeStore } from 'stitchkit/agent-runtime';
import {
  createPostgresAgentRuntimeStore,
  createPostgresAgentRuntimeStoreDriver,
  type PostgresAgentRuntimeStore,
  type PostgresAgentRuntimeStoreConfig,
} from 'stitchkit/agent-runtime/postgres';
import { Prisma, PrismaClient } from './generated/client';

/**
 * Stitchkit's Postgres agent store over a Prisma connection.
 *
 * This is the whole adapter: the store owns its tables, its SQL, its
 * SERIALIZABLE transactions and their retries, and Prisma only carries the
 * statements. `$transaction` opens a fresh interactive transaction per call
 * — the store runs its isolation level as the first statement in it — and
 * `$queryRawUnsafe` runs one statement with `$1…$n` parameters.
 */
export function prismaAgentStoreConfig(
  prisma: PrismaClient,
  prefix?: string,
): PostgresAgentRuntimeStoreConfig<Prisma.TransactionClient> {
  return {
    // Twenty concurrent writers to one conversation queue behind each other's
    // retries; the defaults (2 s to start, 5 s to finish) are a web request's
    // budget, not a store's.
    transaction: (work) => prisma.$transaction(work, { maxWait: 30_000, timeout: 30_000 }),
    query: (tx, text, parameters) => tx.$queryRawUnsafe(text, ...parameters),
    ...(prefix !== undefined && { prefix }),
  };
}

export interface PrismaAgentStoreFixture extends PostgresAgentRuntimeStore {
  prisma: PrismaClient;
  prefix: string;
  /**
   * Make the next write transaction lose a real serialization race at COMMIT.
   * A test seam for `runAgentStoreConformance`: leave it out of a copied adapter.
   */
  armCommitConflict(): Promise<void>;
  /** Rows of one store table for one conversation — what a size assertion reads. */
  count(table: string, conversationId: string, where?: string): Promise<number>;
}

/** The example's test fixture: the adapter above, plus the seams its tests pull. */
export function createPrismaAgentStoreFixture(input: {
  connectionString: string;
  prefix?: string;
  failAfterHistoryApply?: boolean;
}): PrismaAgentStoreFixture {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: input.connectionString }),
  });
  const prefix = input.prefix ?? 'stitchkit_agent_runtime';
  const probe = `${prefix}_probe`;
  let commitConflictArmed = false;
  const base = prismaAgentStoreConfig(prisma, prefix);
  /**
   * A write skew with a concurrent transaction that commits first: each reads
   * the row the other writes, so Postgres has to abort this one, and with
   * nothing left to run it does so at this transaction's COMMIT.
   */
  const skew = async (transaction: Prisma.TransactionClient) => {
    await transaction.$queryRawUnsafe(`SELECT v FROM ${probe} WHERE id = 'b'`);
    await transaction.$queryRawUnsafe(`UPDATE ${probe} SET v = v + 1 WHERE id = 'a'`);
    await prisma.$transaction(
      async (concurrent) => {
        await concurrent.$queryRawUnsafe(`SELECT v FROM ${probe} WHERE id = 'a'`);
        await concurrent.$queryRawUnsafe(`UPDATE ${probe} SET v = v + 1 WHERE id = 'b'`);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  };
  const config: PostgresAgentRuntimeStoreConfig<Prisma.TransactionClient> = {
    ...base,
    transaction: (work) =>
      base.transaction(async (transaction) => {
        const result = await work(transaction);
        if (commitConflictArmed) {
          commitConflictArmed = false;
          await skew(transaction);
        }
        return result;
      }),
  };
  const opened = createPostgresAgentRuntimeStore(config);
  const store = input.failAfterHistoryApply
    ? (() => {
        const driver = createPostgresAgentRuntimeStoreDriver(config);
        return createAgentRuntimeStore({
          ...driver,
          history: {
            ...driver.history,
            async apply(transaction, mutation) {
              await driver.history.apply(transaction, mutation);
              throw new Error('Injected failure after history mutation');
            },
          },
        });
      })()
    : opened.store;
  return {
    ...opened,
    store,
    prisma,
    prefix,
    async armCommitConflict() {
      await prisma.$executeRawUnsafe(
        `CREATE TABLE IF NOT EXISTS ${probe} (id text PRIMARY KEY, v integer NOT NULL)`,
      );
      await prisma.$executeRawUnsafe(
        `INSERT INTO ${probe} VALUES ('a', 0), ('b', 0) ON CONFLICT DO NOTHING`,
      );
      commitConflictArmed = true;
    },
    async count(table, conversationId, where = '') {
      const rows = await prisma.$queryRawUnsafe<{ count: number }[]>(
        `SELECT count(*)::int AS count FROM ${prefix}_${table} WHERE conversation_id = $1 ${where}`,
        conversationId,
      );
      return rows[0]?.count ?? 0;
    },
  };
}
