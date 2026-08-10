import { defineContract } from 'stitchkit/contract';
import { implement } from 'stitchkit/server';
import { createStdioMcpServer } from 'stitchkit/tools';
import { z } from 'zod';

const contract = defineContract(
  { prefix: 'node', scope: 'public' },
  {
    echo: {
      method: 'POST',
      path: '/echo',
      desc: 'Echo through a packed Node stdio consumer',
      expose: ['MCP'],
      input: z.object({ text: z.string() }),
      output: z.object({ text: z.string() }),
    },
  },
);

const service = implement(contract, { echo: ({ input }) => input });
await createStdioMcpServer({
  serverInfo: { name: 'packed-node-stdio', version: '1' },
  auth: {},
  services: [service],
});
