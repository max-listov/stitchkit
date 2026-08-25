import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, readlinkSync } from 'node:fs';
import { SQL } from 'bun';

/**
 * A lane owns the database it creates — including when it dies badly.
 *
 * The same failure as the process sweep next door, one resource along. A lane
 * creates a role and a database, and `dispose()` runs in a `finally`; a
 * `finally` does not run under SIGKILL, and `dispose()` can fail on its own (it
 * did, when the host filled up and `pg_terminate_backend` returned 1). Either
 * way a database and a role survive with a dead process's pid in their names,
 * and nothing will ever come back for them: eighteen of them, 7.4 MB each, had
 * accumulated on one development host.
 *
 * So every run sweeps first, exactly like the processes — and on the same rule,
 * that a sweep may only act on FACTS about what it is deleting, never on a
 * guess. A live sibling run must survive its neighbour's housekeeping.
 */

export interface StarterLaneDatabase {
  url: string;
  dispose(): Promise<void>;
}

/** One `sk_lane_…` object as PostgreSQL reports it. */
export interface LaneRecord {
  name: string;
  connections: number;
}

/**
 * The namespace a pid is a fact about.
 *
 * A pid means nothing on its own. `process.kill(pid, 0)` answers a question
 * about ONE PID NAMESPACE — after a reboot the number belongs to somebody else,
 * on another machine it always did, and in a sibling container of the same
 * kernel it belongs to an unrelated process right now. Deciding from the admin
 * connection's hostname is not a fact at all: `localhost` is equally true
 * through an SSH tunnel, a port-forward and a container bridge.
 *
 * So the name carries the namespace the pid is readable in, and that namespace
 * is built from both facts that bound a pid's meaning:
 *
 * - the boot identifier, which separates one running kernel from the next;
 * - the inode of `/proc/self/ns/pid`, which separates the containers sharing
 *   that kernel — they have ONE boot id and SEPARATE pid namespaces, so the
 *   boot id alone made a live neighbour's pid look dead from here.
 *
 * Both are required. Either one missing means there is no provable identity,
 * and a `DROP DATABASE` decided on a guess is worse than a database left
 * behind — so the cross-run sweep switches OFF rather than running on a
 * fallback, and this run's own records take a namespace nothing will match.
 */
function readFirstLine(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

/** `pid:[4026531836]` — the link body already carries the inode. */
function readPidNamespace(): string | undefined {
  try {
    return readlinkSync('/proc/self/ns/pid').trim() || undefined;
  } catch {
    return undefined;
  }
}

export interface LaneIdentityFacts {
  bootId: string | undefined;
  pidNamespace: string | undefined;
}

/**
 * The namespace these facts prove, or `undefined` when they prove nothing.
 *
 * Pure, and separate from reading `/proc`, because the property worth a test is
 * that two containers of one kernel get DIFFERENT namespaces — which cannot be
 * demonstrated from inside either of them.
 */
export function laneNamespaceDigest(facts: LaneIdentityFacts): string | undefined {
  if (!facts.bootId || !facts.pidNamespace) return undefined;
  return createHash('sha256')
    .update(`${facts.bootId}\n${facts.pidNamespace}`)
    .digest('hex')
    .slice(0, 8);
}

const provenNamespace = laneNamespaceDigest({
  bootId: readFirstLine('/proc/sys/kernel/random/boot_id'),
  pidNamespace: readPidNamespace(),
});

export const LANE_NAMESPACE =
  provenNamespace ??
  createHash('sha256').update(randomBytes(16).toString('hex')).digest('hex').slice(0, 8);

/** Whether a pid found in a lane name can be interrogated from here at all. */
export const LANE_SWEEP_ENABLED = provenNamespace !== undefined;

const LANE_RECORD = /^sk_lane_([0-9a-f]{8})_(\d+)_[a-z0-9_]+_(?:db|role)$/;

/** Whether this record was created by a run of THIS boot of THIS machine. */
export function laneNamespace(name: string): string | undefined {
  return LANE_RECORD.exec(name)?.[1];
}

/** The pid a lane stamped into the name of what it created. */
export function laneOwnerPid(name: string): number | undefined {
  const owner = LANE_RECORD.exec(name)?.[2];
  if (owner === undefined) return undefined;
  const pid = Number(owner);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

/** What a lane's role and database have in common: everything but the suffix. */
export function laneRecordStem(name: string): string | undefined {
  if (!LANE_RECORD.test(name)) return undefined;
  return name.replace(/_(?:db|role)$/, '');
}

/**
 * Which of these were abandoned — decided on two facts, both required.
 *
 * The pid alone is not enough: a lane spends minutes between steps holding no
 * connection at all, and a pid that has been reused by an unrelated process
 * reads as alive. Connections alone are not enough either, for the same reason
 * from the other side — a live run installing dependencies looks exactly like a
 * dead one. Requiring both means the only thing this deletes is an object whose
 * creator is gone AND which nothing is using.
 *
 * A name this cannot read is never touched: it did not come from a lane.
 */
export function selectAbandonedLaneRecords(
  records: readonly LaneRecord[],
  isAlive: (pid: number) => boolean,
): string[] {
  return records
    .filter((record) => {
      // Another machine's — or another boot's — record is never a candidate,
      // whatever its pid looks like from here.
      if (laneNamespace(record.name) !== LANE_NAMESPACE) return false;
      const pid = laneOwnerPid(record.name);
      if (pid === undefined) return false;
      if (pid === process.pid || isAlive(pid)) return false;
      return record.connections === 0;
    })
    .map((record) => record.name);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM is the answer "it exists, and it is not yours" — which is alive.
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

async function run(command: string[]): Promise<void> {
  const child = Bun.spawn(command, {
    stdin: 'ignore',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const exitCode = await child.exited;
  if (exitCode !== 0)
    throw new Error(`${command.join(' ')} failed with exit code ${exitCode}`);
}

async function capture(command: string[]): Promise<string> {
  const child = Bun.spawn(command, { stdin: 'ignore', stdout: 'pipe', stderr: 'inherit' });
  const [output, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ]);
  if (exitCode !== 0)
    throw new Error(`${command.join(' ')} failed with exit code ${exitCode}`);
  return output;
}

async function succeeds(command: string[]): Promise<boolean> {
  const child = Bun.spawn(command, { stdout: 'ignore', stderr: 'ignore' });
  return (await child.exited) === 0;
}

function isSafeIdentifier(value: string): boolean {
  return /^[a-z0-9_]+$/.test(value);
}

function identifier(value: string): string {
  if (!isSafeIdentifier(value)) throw new Error(`Unsafe PostgreSQL identifier: ${value}`);
  return `"${value}"`;
}

function literal(value: string): string {
  if (!/^[a-z0-9_]+$/.test(value)) throw new Error('Unsafe generated PostgreSQL value');
  return `'${value}'`;
}

function databaseUrl(
  adminUrl: string,
  role: string,
  password: string,
  database: string,
): string {
  const url = new URL(adminUrl);
  url.username = role;
  url.password = password;
  url.pathname = `/${database}`;
  return url.toString();
}

interface AdminConnection {
  execute(statement: string): Promise<void>;
  rows(statement: string): Promise<string[][]>;
}

/** Every `sk_lane_…` database, with how many connections it currently has. */
const LANE_DATABASES = `
  SELECT d.datname, coalesce(a.n, 0)
  FROM pg_database d
  LEFT JOIN (
    SELECT datname, count(*) AS n FROM pg_stat_activity WHERE datname IS NOT NULL GROUP BY datname
  ) a ON a.datname = d.datname
  WHERE d.datname ~ '^sk_lane_[0-9a-f]{8}_[0-9]+_'`;

const LANE_ROLES = `SELECT rolname FROM pg_roles WHERE rolname ~ '^sk_lane_[0-9a-f]{8}_[0-9]+_'`;

/**
 * Drop what earlier runs left behind, before adding to it.
 *
 * Best effort by design, and the one place in this file that is: it is
 * housekeeping, not an assertion. A gate that goes green wrongly is worse than
 * no gate — but this decides nothing about the run, so a failure to tidy is
 * reported and the run continues. What it must never do is delete something in
 * use, and that is what `selectAbandonedLaneRecords` is for.
 *
 * Databases first, then roles: a role still owning a database cannot be
 * dropped, so the second pass reads the state the first one left.
 */
async function sweepAbandonedLaneDatabases(connection: AdminConnection): Promise<void> {
  if (!LANE_SWEEP_ENABLED) {
    console.log(
      '[lane-database] sweep disabled: this run cannot prove which pid namespace a lane name refers to',
    );
    return;
  }
  const problems: string[] = [];
  const drop = async (statement: string, name: string): Promise<boolean> => {
    try {
      await connection.execute(statement);
      return true;
    } catch (error) {
      // A live run may have connected between the query and this statement.
      // That is the sweep losing a race it is allowed to lose.
      problems.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };

  const databases = (await connection.rows(LANE_DATABASES)).flatMap((row) => {
    const [name, connections] = row;
    return name ? [{ name, connections: Number(connections ?? 0) }] : [];
  });
  let droppedDatabases = 0;
  const kept = new Set(databases.map((record) => record.name));
  for (const name of selectAbandonedLaneRecords(databases, processIsAlive)) {
    if (!isSafeIdentifier(name)) continue;
    if (await drop(`DROP DATABASE IF EXISTS ${identifier(name)}`, name)) {
      droppedDatabases += 1;
      kept.delete(name);
    }
  }

  // A role is only abandoned once no database of the same lane is left — the
  // one it owns may be the database this pass deliberately did not touch.
  const survivingStems = new Set([...kept].flatMap((name) => laneRecordStem(name) ?? []));
  const roles = (await connection.rows(LANE_ROLES)).flatMap((row) => {
    const [name] = row;
    return name ? [{ name, connections: 0 }] : [];
  });
  let droppedRoles = 0;
  for (const name of selectAbandonedLaneRecords(roles, processIsAlive)) {
    const stem = laneRecordStem(name);
    if (!stem || survivingStems.has(stem) || !isSafeIdentifier(name)) continue;
    if (await drop(`DROP ROLE IF EXISTS ${identifier(name)}`, name)) droppedRoles += 1;
  }

  if (droppedDatabases > 0 || droppedRoles > 0) {
    console.log(
      `[lane-database] dropped ${droppedDatabases} database(s) and ${droppedRoles} role(s) abandoned by earlier runs`,
    );
  }
  if (problems.length > 0) {
    console.log(`[lane-database] could not drop ${problems.length}: ${problems.join('; ')}`);
  }
}

export async function createStarterLaneDatabase(mode: string): Promise<StarterLaneDatabase> {
  const suffix = randomBytes(4).toString('hex');
  const stem = `sk_lane_${LANE_NAMESPACE}_${process.pid}_${mode}_${suffix}`.replaceAll(
    '-',
    '_',
  );
  const role = `${stem}_role`;
  const database = `${stem}_db`;
  const password = randomBytes(24).toString('hex');
  const roleName = identifier(role);
  const databaseName = identifier(database);
  const adminUrl = Bun.env.STARTER_TEST_DATABASE_ADMIN_URL;

  let execute: (statement: string) => Promise<void>;
  let rows: (statement: string) => Promise<string[][]>;
  let close: () => Promise<void>;
  let url: string;

  if (adminUrl) {
    const sql = new SQL(adminUrl);
    execute = async (statement) => {
      await sql.unsafe(statement);
    };
    rows = async (statement) => {
      const result: unknown = await sql.unsafe(statement);
      if (!Array.isArray(result)) return [];
      return result.map((row) =>
        typeof row === 'object' && row !== null
          ? Object.values(row).map((value) => (value === null ? '' : String(value)))
          : [],
      );
    };
    close = async () => {
      await sql.close();
    };
    url = databaseUrl(adminUrl, role, password, database);
  } else {
    const localAdmin =
      Bun.which('sudo') &&
      (await succeeds([
        'sudo',
        '-n',
        '-u',
        'postgres',
        'psql',
        '--dbname',
        'postgres',
        '--command',
        'SELECT 1',
      ]));
    if (!localAdmin) {
      throw new Error(
        'Set STARTER_TEST_DATABASE_ADMIN_URL to a PostgreSQL admin connection URL',
      );
    }
    const psql = (extra: string[], statement: string) => [
      'sudo',
      '-n',
      '-u',
      'postgres',
      'psql',
      '--set',
      'ON_ERROR_STOP=1',
      ...extra,
      '--dbname',
      'postgres',
      '--command',
      statement,
    ];
    execute = (statement) => run(psql([], statement));
    // `-tA` is tuples only, unaligned: no header, no padding, one row per line
    // with `|` between columns — a shape that can be read rather than eyeballed.
    rows = async (statement) =>
      (await capture(psql(['-tA'], statement)))
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => line.split('|'));
    close = async () => undefined;
    url = `postgresql://${role}:${password}@127.0.0.1:5432/${database}`;
  }

  // Before adding to what an earlier run left behind — the same rule the
  // process sweep follows, and for the same reason. Safe against a shared
  // server too: the namespace in each name says whose record it is.
  try {
    await sweepAbandonedLaneDatabases({ execute, rows });
  } catch (error) {
    console.log(
      `[lane-database] sweep skipped: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let roleCreated = false;
  let databaseCreated = false;
  try {
    await execute(`CREATE ROLE ${roleName} LOGIN PASSWORD ${literal(password)}`);
    roleCreated = true;
    await execute(`CREATE DATABASE ${databaseName} OWNER ${roleName}`);
    databaseCreated = true;
  } catch (error) {
    // Same rule as `dispose()`, and it was missing here: stopping at the first
    // rollback failure leaves the rest of the rollback undone AND the
    // connection open, and reports only the rollback error instead of the
    // failure that caused it.
    const rollback: unknown[] = [];
    for (const step of [
      async () => {
        if (databaseCreated) await execute(`DROP DATABASE IF EXISTS ${databaseName}`);
      },
      async () => {
        if (roleCreated) await execute(`DROP ROLE IF EXISTS ${roleName}`);
      },
      close,
    ]) {
      try {
        await step();
      } catch (rollbackError) {
        rollback.push(rollbackError);
      }
    }
    if (rollback.length === 0) throw error;
    throw new AggregateError(
      [error, ...rollback],
      `Creating the lane database ${database} failed, and so did its rollback`,
    );
  }

  return {
    url,
    /**
     * Every step attempted, every failure reported.
     *
     * Stopping at the first one is how a failed `pg_terminate_backend` left the
     * database AND the role behind: the two `DROP`s after it never ran, and the
     * only thing anyone saw was the first error. The steps are ordered, not
     * dependent — dropping is worth trying even when the terminate failed.
     */
    async dispose() {
      const failures: unknown[] = [];
      for (const statement of [
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${literal(database)} AND pid <> pg_backend_pid()`,
        `DROP DATABASE IF EXISTS ${databaseName}`,
        `DROP ROLE IF EXISTS ${roleName}`,
      ]) {
        try {
          await execute(statement);
        } catch (error) {
          failures.push(error);
        }
      }
      try {
        await close();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, `Disposing the lane database ${database} failed`);
      }
    },
  };
}
