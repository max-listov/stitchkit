import { randomBytes } from 'node:crypto';
import { SQL } from 'bun';

export interface StarterLaneDatabase {
  url: string;
  dispose(): Promise<void>;
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

async function succeeds(command: string[]): Promise<boolean> {
  const child = Bun.spawn(command, { stdout: 'ignore', stderr: 'ignore' });
  return (await child.exited) === 0;
}

function identifier(value: string): string {
  if (!/^[a-z0-9_]+$/.test(value)) throw new Error(`Unsafe PostgreSQL identifier: ${value}`);
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

export async function createStarterLaneDatabase(mode: string): Promise<StarterLaneDatabase> {
  const suffix = randomBytes(4).toString('hex');
  const stem = `sk_lane_${process.pid}_${mode}_${suffix}`.replaceAll('-', '_');
  const role = `${stem}_role`;
  const database = `${stem}_db`;
  const password = randomBytes(24).toString('hex');
  const roleName = identifier(role);
  const databaseName = identifier(database);
  const adminUrl = Bun.env.STARTER_TEST_DATABASE_ADMIN_URL;

  let execute: (statement: string) => Promise<void>;
  let close: () => Promise<void>;
  let url: string;

  if (adminUrl) {
    const sql = new SQL(adminUrl);
    execute = async (statement) => {
      await sql.unsafe(statement);
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
    execute = (statement) =>
      run([
        'sudo',
        '-n',
        '-u',
        'postgres',
        'psql',
        '--set',
        'ON_ERROR_STOP=1',
        '--dbname',
        'postgres',
        '--command',
        statement,
      ]);
    close = async () => undefined;
    url = `postgresql://${role}:${password}@127.0.0.1:5432/${database}`;
  }

  let roleCreated = false;
  let databaseCreated = false;
  try {
    await execute(`CREATE ROLE ${roleName} LOGIN PASSWORD ${literal(password)}`);
    roleCreated = true;
    await execute(`CREATE DATABASE ${databaseName} OWNER ${roleName}`);
    databaseCreated = true;
  } catch (error) {
    if (databaseCreated) await execute(`DROP DATABASE IF EXISTS ${databaseName}`);
    if (roleCreated) await execute(`DROP ROLE IF EXISTS ${roleName}`);
    await close();
    throw error;
  }

  return {
    url,
    async dispose() {
      await execute(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${literal(database)} AND pid <> pg_backend_pid()`,
      );
      await execute(`DROP DATABASE IF EXISTS ${databaseName}`);
      await execute(`DROP ROLE IF EXISTS ${roleName}`);
      await close();
    },
  };
}
