// A real CLI with DEFAULT stdout/exit, printing a payload far beyond the pipe
// buffer. The sync-stdout test spawns it and asserts nothing is truncated —
// the async default writer + immediate process.exit used to cut output at
// exactly 65536 bytes.
import { z } from 'zod';
import { defineContract } from '../../src/contract';
import { implement } from '../../src/server';
import { createCli } from '../../src/tools/cli';

const SIZE = Number(process.env.STITCHKIT_TEST_PAYLOAD_SIZE ?? 200_000);

const contract = defineContract(
  { prefix: 'big', scope: 'public' },
  {
    blob: {
      method: 'GET',
      path: '/',
      desc: 'Big payload',
      toolName: 'blob',
      expose: ['CLI'],
      output: z.object({ data: z.string() }),
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
