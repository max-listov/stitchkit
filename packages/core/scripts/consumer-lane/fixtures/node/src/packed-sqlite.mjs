/**
 * The SQLite store as the guide constructs it, under either runtime.
 *
 * `createBunSqliteAgentRuntimeStore` / `createNodeSqliteAgentRuntimeStore`
 * return the handle whose `database` the companions share and whose
 * `transaction` they write through — the documented path, not a copy of the
 * package's own adapter.
 */
const sqliteModule = process.versions.bun
  ? await import('stitchkit/agent-runtime/sqlite/bun')
  : await import('stitchkit/agent-runtime/sqlite/node');

export function packedSqlite(filename = ':memory:') {
  const handle = process.versions.bun
    ? sqliteModule.createBunSqliteAgentRuntimeStore({ filename })
    : sqliteModule.createNodeSqliteAgentRuntimeStore({ filename });
  return { database: handle.database, handle };
}

export async function rawDatabase(filename) {
  const Database = process.versions.bun
    ? (await import('bun:sqlite')).Database
    : (await import('node:sqlite')).DatabaseSync;
  return new Database(filename);
}

export function proof(name, ok, detail) {
  if (ok) {
    console.log(`packed ${name}: ok`);
    return;
  }
  console.error(`[${name}] ${detail}`);
  process.exitCode = 1;
}
