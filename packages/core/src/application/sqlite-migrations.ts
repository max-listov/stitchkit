/**
 * Ordered SQLite migrations with a ledger that refuses a changed history.
 *
 * Every SQLite host of an offline-first app — a desktop runtime on `bun:sqlite`,
 * a phone on `expo-sqlite` — keeps the same record of which migrations a database
 * has applied, and the same rule: an applied migration whose name or text no
 * longer matches means the schema is not the one this code built, and nothing is
 * applied on top of it. The ledger's shape and checksum are those of the
 * consuming apps that already ship it — the `schema_migrations` table and a
 * 32-bit FNV-1a over the statements — so their existing databases read as
 * theirs. FNV-1a is plain JavaScript: it runs in Hermes and in a browser, where
 * `crypto.subtle` may be missing.
 *
 * The plan is pure; running it is one transaction per migration. The synchronous
 * runner never awaits inside a transaction, so nothing else on the connection can
 * slip into it (ADR 0128). The asynchronous one is for drivers that only speak
 * promises; the caller holds the connection to itself while it runs.
 */
import {
  rollbackSqliteFailure,
  rollbackSqliteFailureAsync,
  type SqliteDatabase,
} from '../internal/sqlite';

/** Authored SQLite migration definition before checksum computation. */
export interface SqliteMigrationDefinition {
  readonly version: number;
  readonly name: string;
  readonly statements: readonly string[];
}

/** Validated SQLite migration definition with its deterministic FNV-1a checksum. */
export interface SqliteMigration extends SqliteMigrationDefinition {
  /** 32-bit FNV-1a of `statements.join('\n')`, eight lowercase hex digits. */
  readonly checksum: string;
}

/** Migration name and checksum recorded in the `schema_migrations` ledger. */
export interface AppliedSqliteMigration {
  readonly name: string;
  readonly checksum: string;
}

/** The ledger a list without its own `ledger` name is recorded in. */
const DEFAULT_LEDGER = 'schema_migrations';

/**
 * A ledger is a table this module names in SQL, so its name is a plain identifier: a letter or
 * `_` first, then letters, digits and `_`, at most 64 characters, and never SQLite's own
 * `sqlite_` prefix. Anything else is refused before a statement runs.
 */
const LEDGER_NAME = /^(?!sqlite_)[A-Za-z_][A-Za-z0-9_]{0,63}$/i;

function ledgerTable(ledger: string | undefined): string {
  const name = ledger ?? DEFAULT_LEDGER;
  if (!LEDGER_NAME.test(name))
    throw new TypeError(`Migration ledger "${name}" is not a plain SQL identifier`);
  return name;
}

function ledgerSql(table: string): string {
  return `CREATE TABLE IF NOT EXISTS "${table}" (
  "version" INTEGER PRIMARY KEY NOT NULL,
  "name" TEXT NOT NULL,
  "checksum" TEXT NOT NULL,
  "applied_at" TEXT NOT NULL
);`;
}

/** The ledger every host keeps: which migration versions this database has applied. */
export const SQLITE_MIGRATION_LEDGER_SQL = ledgerSql(DEFAULT_LEDGER);

/** How a migration's transaction begins: `IMMEDIATE` takes the write lock at once. */
export type SqliteMigrationBegin = 'DEFERRED' | 'IMMEDIATE' | 'EXCLUSIVE';

const BEGIN_MODES: readonly SqliteMigrationBegin[] = ['DEFERRED', 'IMMEDIATE', 'EXCLUSIVE'];

/** The statement that opens each migration's transaction; a mode SQLite does not name is refused. */
function beginStatement(begin: SqliteMigrationBegin | undefined): string {
  const mode = begin ?? 'IMMEDIATE';
  if (!BEGIN_MODES.includes(mode))
    throw new TypeError(
      `[stitchkit] sqlite migrations: begin is 'DEFERRED', 'IMMEDIATE' or 'EXCLUSIVE', received ${JSON.stringify(begin)}`,
    );
  return `BEGIN ${mode}`;
}

/** The ledger names other migrations than this code has: the schema is not this code's. */
export class SqliteMigrationLedgerMismatchError extends Error {
  readonly scope: string;
  readonly version: number;
  constructor(scope: string, version: number) {
    super(`${scope} migration ${version} changed after application`);
    this.name = 'SqliteMigrationLedgerMismatchError';
    this.scope = scope;
    this.version = version;
  }
}

/** A migration failed and rolled back; `cause` is the driver's error. */
export class SqliteMigrationFailedError extends Error {
  readonly scope: string;
  readonly version: number;
  constructor(scope: string, version: number, cause: unknown) {
    super(`${scope} migration ${version} failed`, { cause });
    this.name = 'SqliteMigrationFailedError';
    this.scope = scope;
    this.version = version;
  }
}

/** The ledger holds a row this code cannot read: the database is not one it can judge. */
export class SqliteMigrationLedgerUnreadableError extends Error {
  readonly scope: string;
  constructor(scope: string) {
    super(`${scope} migration ledger holds a row that is not a migration`);
    this.name = 'SqliteMigrationLedgerUnreadableError';
    this.scope = scope;
  }
}

function checksum(statements: readonly string[]): string {
  let hash = 2166136261;
  const value = statements.join('\n');
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Checksum each migration; a version or name repeated, or a version that is not a positive integer, refuses. */
export function defineSqliteMigrations(
  definitions: readonly SqliteMigrationDefinition[],
): readonly SqliteMigration[] {
  const versions = new Set<number>();
  const names = new Set<string>();
  for (const { version, name, statements } of definitions) {
    if (!Number.isSafeInteger(version) || version <= 0)
      throw new TypeError(`Migration version ${version} is not a positive integer`);
    if (versions.has(version)) throw new TypeError(`Migration version ${version} is repeated`);
    if (names.has(name)) throw new TypeError(`Migration name "${name}" is repeated`);
    if (statements.length === 0) throw new TypeError(`Migration ${version} has no statements`);
    versions.add(version);
    names.add(name);
  }
  return definitions.map((migration) => ({
    ...migration,
    checksum: checksum(migration.statements),
  }));
}

/**
 * The migrations still to apply, in version order. Every applied migration is
 * checked first, so a mismatching ledger changes nothing. A ledger ahead of this
 * code — a newer app wrote versions this one does not know — is not an error:
 * those versions are simply not this code's. What to do about a mismatch is the
 * host's decision: set the database aside, or refuse to open it.
 */
export interface SqliteMigrationPlanInput {
  /** Names the database in a mismatch: `device`, `account:a1`. */
  readonly scope: string;
  /** What the ledger says is applied, by version. */
  readonly applied: ReadonlyMap<number, AppliedSqliteMigration>;
  readonly migrations: readonly SqliteMigration[];
}

/** Verify applied ledger checksums and return pending SQLite migrations in version order. */
export function planSqliteMigrations(
  input: SqliteMigrationPlanInput,
): readonly SqliteMigration[] {
  const { scope, applied, migrations } = input;
  for (const migration of migrations) {
    const existing = applied.get(migration.version);
    if (
      existing &&
      (existing.name !== migration.name || existing.checksum !== migration.checksum)
    )
      throw new SqliteMigrationLedgerMismatchError(scope, migration.version);
  }
  return migrations
    .filter((migration) => !applied.has(migration.version))
    .sort((left, right) => left.version - right.version);
}

const MAX_SAFE_VERSION_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

function parseLedgerVersion(raw: unknown): number | undefined {
  if (typeof raw === 'number') {
    return Number.isSafeInteger(raw) && raw > 0 ? raw : undefined;
  }
  if (typeof raw === 'bigint') {
    return raw > 0n && raw <= MAX_SAFE_VERSION_BIGINT ? Number(raw) : undefined;
  }
  return undefined;
}

function appliedFrom(
  scope: string,
  rows: readonly unknown[],
): Map<number, AppliedSqliteMigration> {
  const applied = new Map<number, AppliedSqliteMigration>();
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) {
      throw new SqliteMigrationLedgerUnreadableError(scope);
    }
    const version = parseLedgerVersion(Reflect.get(row, 'version'));
    const name = Reflect.get(row, 'name');
    const sum = Reflect.get(row, 'checksum');
    if (
      version === undefined ||
      typeof name !== 'string' ||
      typeof sum !== 'string' ||
      applied.has(version)
    ) {
      throw new SqliteMigrationLedgerUnreadableError(scope);
    }
    applied.set(version, { name, checksum: sum });
  }
  return applied;
}

/** The three statements one ledger is read and written with. */
function ledgerStatements(ledger: string | undefined) {
  const table = ledgerTable(ledger);
  return {
    create: ledgerSql(table),
    select: `SELECT "version", "name", "checksum" FROM "${table}"`,
    insert: `INSERT INTO "${table}" ("version", "name", "checksum", "applied_at") VALUES (?, ?, ?, ?)`,
  };
}

/** Execution parameters for running ordered SQLite migrations against a database. */
export interface SqliteMigrationRun {
  /** Names the database in a mismatch: `device`, `account:a1`. */
  readonly scope: string;
  readonly migrations: readonly SqliteMigration[];
  /**
   * The table this list is recorded in. Default `schema_migrations`. Independent lists in one
   * database — a queue's tables and a replica's — each name their own (`queue_migrations`), so
   * each numbers its versions from 1 and neither reads the other's history.
   */
  readonly ledger?: string;
  /** How each migration's transaction begins. Default `IMMEDIATE`. */
  readonly begin?: SqliteMigrationBegin;
  readonly now?: () => Date;
}

/** Apply what is missing on a synchronous connection; returns the versions applied, in order. */
export function runSqliteMigrations(
  database: SqliteDatabase,
  run: SqliteMigrationRun,
): readonly number[] {
  const ledger = ledgerStatements(run.ledger);
  const begin = beginStatement(run.begin);
  database.exec(ledger.create);
  const plan = planSqliteMigrations({
    scope: run.scope,
    applied: appliedFrom(run.scope, database.prepare(ledger.select).all()),
    migrations: run.migrations,
  });
  const now = run.now ?? (() => new Date());
  const applied: number[] = [];
  for (const migration of plan) {
    database.exec(begin);
    // The plan was read before this transaction existed. Another connection on the same
    // file may have applied the version meanwhile: the ledger is read again where no one
    // else can write it, and a version already there is not run twice.
    let pending: boolean;
    try {
      pending = stillPending(
        run,
        migration,
        appliedFrom(run.scope, database.prepare(ledger.select).all()),
      );
    } catch (error) {
      throw rollbackSqliteFailure(database, error);
    }
    if (!pending) {
      database.exec('ROLLBACK');
      continue;
    }
    try {
      for (const statement of migration.statements) database.exec(statement);
      database
        .prepare(ledger.insert)
        .run(migration.version, migration.name, migration.checksum, now().toISOString());
      database.exec('COMMIT');
    } catch (error) {
      throw new SqliteMigrationFailedError(
        run.scope,
        migration.version,
        rollbackSqliteFailure(database, error),
      );
    }
    applied.push(migration.version);
  }
  return applied;
}

/**
 * Whether `migration` is still to be applied, by the ledger as it stands now. A ledger that
 * disagrees with the declared migrations refuses here exactly as it does when the run is planned.
 */
function stillPending(
  run: SqliteMigrationRun,
  migration: SqliteMigration,
  applied: ReadonlyMap<number, { name: string; checksum: string }>,
): boolean {
  return planSqliteMigrations({ scope: run.scope, applied, migrations: run.migrations }).some(
    (planned) => planned.version === migration.version,
  );
}

/** A connection that only speaks promises, such as an async `expo-sqlite` handle. */
export interface AsyncSqliteConnection {
  exec(sql: string): Promise<void>;
  all(sql: string): Promise<readonly unknown[]>;
  run(sql: string, ...parameters: (string | number)[]): Promise<void>;
}

/**
 * The same plan on an asynchronous connection. Awaiting inside a transaction lets
 * other work on the same connection run in it, so the caller gives this run the
 * connection alone until it settles.
 */
export async function runSqliteMigrationsAsync(
  connection: AsyncSqliteConnection,
  run: SqliteMigrationRun,
): Promise<readonly number[]> {
  const ledger = ledgerStatements(run.ledger);
  const begin = beginStatement(run.begin);
  await connection.exec(ledger.create);
  const plan = planSqliteMigrations({
    scope: run.scope,
    applied: appliedFrom(run.scope, await connection.all(ledger.select)),
    migrations: run.migrations,
  });
  const now = run.now ?? (() => new Date());
  const applied: number[] = [];
  for (const migration of plan) {
    await connection.exec(begin);
    let pending: boolean;
    try {
      pending = stillPending(
        run,
        migration,
        appliedFrom(run.scope, await connection.all(ledger.select)),
      );
    } catch (error) {
      throw await rollbackSqliteFailureAsync(connection, error);
    }
    if (!pending) {
      await connection.exec('ROLLBACK');
      continue;
    }
    try {
      for (const statement of migration.statements) await connection.exec(statement);
      await connection.run(
        ledger.insert,
        migration.version,
        migration.name,
        migration.checksum,
        now().toISOString(),
      );
      await connection.exec('COMMIT');
    } catch (error) {
      throw new SqliteMigrationFailedError(
        run.scope,
        migration.version,
        await rollbackSqliteFailureAsync(connection, error),
      );
    }
    applied.push(migration.version);
  }
  return applied;
}
