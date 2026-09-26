import { z } from 'zod';
import {
  createCli,
  createCliInvoker,
  defineCliCommand,
  defineCliStreamCommand,
} from '../../src/entrypoints/cli';
import { defineContract } from '../../src/entrypoints/contract';
import { implement } from '../../src/entrypoints/server';

const input = z.object({ text: z.string() });
const service = implement(
  defineContract(
    { prefix: 'probe' },
    {
      need: {
        method: 'POST',
        path: '/',
        desc: 'Echo managed text',
        expose: ['CLI'],
        input,
        output: input,
        tool: { name: 'managed' },
      },
    },
  ),
  { need: ({ input }) => input },
);
const invoker = await createCliInvoker({ name: 'stdin-probe', services: [service] });

await createCli({
  name: 'stdin-probe',
  version: '0.0.0',
  ...(process.env.STITCHKIT_TEST_EXPLICIT_STDIN === '1' && {
    stdin: async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks).toString('utf8');
    },
  }),
  services: [service],
  commands: [
    defineCliStreamCommand({ invoker }),
    defineCliCommand({
      name: 'need',
      description: 'Echo required text',
      input: z.object({ text: z.string() }),
      output: z.object({ text: z.string() }),
      handler: ({ input }) => input,
    }),
  ],
});
