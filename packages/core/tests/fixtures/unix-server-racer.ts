// Helper child process for multi-process unix socket startup race tests.
// Starts a Stitchkit server on STITCHKIT_TEST_UNIX_PATH, reports outcome as one
// JSON line on stdout, serves GET /who until stdin closes, then shuts down.
import { lstatSync } from 'node:fs';
import { z } from 'zod';
import { defineContract } from '../../src/entrypoints/contract';
import { createServer, implement } from '../../src/entrypoints/server';

const path = process.env.STITCHKIT_TEST_UNIX_PATH;
const id = process.env.STITCHKIT_TEST_RACER_ID ?? 'unknown';
const modeRaw = process.env.STITCHKIT_TEST_UNIX_MODE;
const mode = modeRaw ? Number.parseInt(modeRaw, 8) : undefined;
if (!path) throw new Error('STITCHKIT_TEST_UNIX_PATH is required');

const whoContract = defineContract(
  { prefix: 'who' },
  {
    get: {
      method: 'GET',
      path: '/',
      desc: 'Report which racer owns the socket',
      output: z.object({ id: z.string() }),
    },
  },
);

const whoService = implement(whoContract, {
  get: () => ({ id }),
});

// Signal parent once all modules are loaded so racers call createServer at the same instant.
process.stdout.write('ready\n');
const reader = Bun.stdin.stream().getReader();
const decoder = new TextDecoder();
let buf = '';
while (!buf.includes('go\n')) {
  const { value, done } = await reader.read();
  if (done) break;
  buf += decoder.decode(value, { stream: true });
}

try {
  const unix = mode === undefined ? path : { path, mode };
  const server = createServer({ unix, services: [whoService] });
  const stats = lstatSync(path);
  process.stdout.write(
    `${JSON.stringify({ status: 'started', id, dev: stats.dev, ino: stats.ino })}\n`,
  );
  // Wait for parent to close stdin before shutting down.
  while (true) {
    const { done } = await reader.read();
    if (done) break;
  }
  await server.shutdown({ gracePeriodMs: 1_000 });
  process.exit(0);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(`${JSON.stringify({ status: 'failed', id, message })}\n`);
  process.exit(1);
}
