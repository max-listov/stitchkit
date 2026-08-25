import { createStarterLaneDatabase } from './starter-database';

async function run(command: string[], databaseUrl: string): Promise<void> {
  const child = Bun.spawn(command, {
    cwd: `${import.meta.dir}/..`,
    env: { ...Bun.env, AGENT_STORE_DATABASE_URL: databaseUrl },
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`${command.join(' ')} failed with ${exitCode}`);
}

const database = await createStarterLaneDatabase('agent_store');
// Boxed, so a thrown `undefined` is still recorded as a failure.
let laneFailure: { error: unknown } | undefined;
try {
  await run(
    ['bunx', 'prisma', 'generate', '--config', 'examples/agent-store-prisma/prisma.config.ts'],
    database.url,
  );
  await run(
    [
      'bunx',
      'prisma',
      'db',
      'push',
      '--config',
      'examples/agent-store-prisma/prisma.config.ts',
    ],
    database.url,
  );
  await run(
    ['bun', 'x', 'tsc', '-p', 'examples/agent-store-prisma/tsconfig.json'],
    database.url,
  );
  await run(['bun', 'test', 'examples/agent-store-prisma/adapter.test.ts'], database.url);
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
  throw new AggregateError(failures, 'The agent-store lane failed, and so did its cleanup');
}
