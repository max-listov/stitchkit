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
} finally {
  await database.dispose();
}
