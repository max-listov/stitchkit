/**
 * The one Postgres boundary the stores type against: run one statement with
 * `$1…$n` parameters in the caller's transaction, resolve with its rows.
 *
 * Stitchkit never opens a connection or imports a client. The application
 * hands a store its transaction and this function, so Bun's SQL client,
 * Prisma and `pg` all fit without an adapter of ours:
 *
 * - Bun: `(tx, text, parameters) => tx.unsafe(text, [...parameters])`
 * - Prisma: `(tx, text, parameters) => tx.$queryRawUnsafe(text, ...parameters)`
 * - `pg`: `async (client, text, parameters) => (await client.query(text, [...parameters])).rows`
 */
export type PostgresSqlParameter = string | number | boolean | null | Uint8Array;

/** Execute one parameterized SQL statement within caller transaction `TX` and resolve its rows. */
export type PostgresQuery<TX> = (
  tx: TX,
  text: string,
  parameters: readonly PostgresSqlParameter[],
) => Promise<readonly unknown[]>;
