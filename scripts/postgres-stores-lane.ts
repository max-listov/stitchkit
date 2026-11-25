/**
 * The stores stitchkit ships for Postgres, against a real one: the agent store
 * and its companions through Bun's SQL client and through the Prisma example,
 * the Telegram update store and the sync server store through Bun's SQL
 * client. One throwaway database for all; each store keeps to its own tables.
 */
import { createStarterLaneDatabase } from './starter-database';

function laneEnv(databaseUrl: string) {
  return {
    ...Bun.env,
    AGENT_STORE_DATABASE_URL: databaseUrl,
    TELEGRAM_STORE_DATABASE_URL: databaseUrl,
    SYNC_STORE_DATABASE_URL: databaseUrl,
  };
}

async function run(command: string[], databaseUrl: string): Promise<void> {
  const child = Bun.spawn(command, {
    cwd: `${import.meta.dir}/..`,
    env: laneEnv(databaseUrl),
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`${command.join(' ')} failed with ${exitCode}`);
}

/**
 * One test file, refused when it ran no test.
 *
 * Every file here skips itself without its database URL, and a skipped file
 * exits 0: a lane that lost the variable, or a file whose `describe.skipIf`
 * misfired, would pass having proven nothing. Bun prints its summary on
 * stderr; the count of passed tests is read from there.
 */
async function testFile(file: string, databaseUrl: string): Promise<void> {
  const child = Bun.spawn(['bun', 'test', file], {
    cwd: `${import.meta.dir}/..`,
    env: laneEnv(databaseUrl),
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'pipe',
  });
  const errors = await new Response(child.stderr).text();
  process.stderr.write(errors);
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`bun test ${file} failed with ${exitCode}`);
  const passed = Number(/^\s*(\d+) pass$/m.exec(errors)?.[1] ?? 0);
  if (passed === 0) throw new Error(`bun test ${file} ran no test against Postgres`);
}

const database = await createStarterLaneDatabase('stores');
// Boxed, so a thrown `undefined` is still recorded as a failure.
let laneFailure: { error: unknown } | undefined;
try {
  await run(
    ['bunx', 'prisma', 'generate', '--config', 'examples/agent-store-prisma/prisma.config.ts'],
    database.url,
  );
  await run(
    ['bun', 'x', 'tsc', '-p', 'examples/agent-store-prisma/tsconfig.json'],
    database.url,
  );
  for (const file of [
    'examples/agent-store-prisma/adapter.test.ts',
    'packages/core/tests/agent-runtime-store-postgres.test.ts',
    'packages/core/tests/agent-runtime-companions-postgres.test.ts',
    'packages/core/tests/agent-runtime-event-search-backends.test.ts',
    'packages/core/tests/telegram-update-store.test.ts',
    'packages/core/tests/sync-server-store.test.ts',
  ]) {
    await testFile(file, database.url);
  }
} catch (error) {
  laneFailure = { error };
}

// Disposing can fail on its own, and that is worth reporting — but never
// INSTEAD of the failure the lane already has. A `finally` that throws would
// discard it.
const failures: unknown[] = laneFailure ? [laneFailure.error] : [];
try {
  await database.dispose();
} catch (error) {
  failures.push(error);
}
if (failures.length === 1) throw failures[0];
if (failures.length > 1) {
  throw new AggregateError(
    failures,
    'The Postgres stores lane failed, and so did its cleanup',
  );
}
