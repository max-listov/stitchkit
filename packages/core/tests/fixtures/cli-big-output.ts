// A real CLI with DEFAULT stdout/exit, printing a payload far beyond the pipe
// buffer. The sync-stdout test spawns it and asserts nothing is truncated —
// the async default writer + immediate process.exit used to cut output at
// exactly 65536 bytes.
import { z } from 'zod';
import { defineContract } from '../../src/entrypoints/contract';
import { implement } from '../../src/entrypoints/server';
import { createCli } from '../../src/tools/cli/create-cli';

const SIZE = Number(process.env.STITCHKIT_TEST_PAYLOAD_SIZE ?? 200_000);

// Touching `process.stdout` is what makes fd 1 NON-BLOCKING — the runtime
// creates the WriteStream and sets O_NONBLOCK on it. Any real CLI does this the
// moment it calls `console.log` once, anywhere. It is opt-in here so the two
// tests stay one subject each: the original one proves a blocking descriptor is
// not cut by `process.exit`, this flag turns the descriptor into the one where
// a short `writeSync` silently drops the tail.
if (process.env.STITCHKIT_TEST_NONBLOCKING_STDOUT === '1') void process.stdout;

const contract = defineContract(
  { prefix: 'big', scope: 'public' },
  {
    blob: {
      method: 'GET',
      path: '/',
      desc: 'Big payload',
      expose: ['CLI'],
      output: z.object({ data: z.string() }),
      tool: { name: 'blob' },
    },
  },
);

const service = implement(contract, {
  blob: () => ({ data: 'x'.repeat(SIZE) }),
});

await createCli({
  name: 'big',
  version: '0.0.0',
  services: [service],
  stdin: async () => null,
});
