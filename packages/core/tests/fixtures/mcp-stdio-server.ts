import { z } from 'zod';
import { defineContract } from '../../src/contract';
import { getRequestContext } from '../../src/observability';
import { createImplement } from '../../src/server/implement';
import { createStdioMcpServer } from '../../src/tools/mcp-stdio';

const contract = defineContract(
  { prefix: 'stdio', scope: 'public' },
  {
    echo: {
      method: 'POST',
      path: '/echo',
      desc: 'Echo through stdio',
      expose: ['MCP'],
      input: z.object({ text: z.string() }),
      output: z.object({ text: z.string() }),
    },
    values: {
      method: 'GET',
      path: '/values',
      desc: 'Return direct JSON values through stdio',
      expose: ['MCP'],
      output: z.array(z.string()),
    },
    trace: {
      method: 'GET',
      path: '/trace',
      desc: 'Inspect stdio trace propagation',
      expose: ['MCP'],
      output: z.object({
        traceId: z.string(),
        parentSpanId: z.string().optional(),
        tracestate: z.string().optional(),
        baggage: z.string().optional(),
      }),
    },
    confirm: {
      method: 'POST',
      path: '/confirm',
      desc: 'Confirm through a multi-round stdio call',
      expose: ['MCP'],
      input: z.object({ operation: z.string() }),
      output: z.object({ operation: z.string(), confirmed: z.boolean() }),
      mcp: {
        inputRequired: [
          {
            key: 'confirmation',
            message: 'Continue?',
            schema: z.object({ confirmed: z.boolean() }),
          },
        ],
      },
    },
  },
);

const implement = createImplement();
const service = implement(contract, {
  echo: ({ input }) => input,
  values: () => ['one', 'two'],
  trace: () => {
    const trace = getRequestContext()?.trace;
    if (!trace) throw new Error('missing stdio MCP trace context');
    return trace;
  },
  confirm: ({ input, mcpInput }) => ({
    operation: input.operation,
    confirmed: mcpInput?.confirmation.confirmed ?? false,
  }),
});

console.error('stitchkit-stdio-ready');
await createStdioMcpServer({
  serverInfo: { name: 'stitchkit-stdio-test', version: '1' },
  auth: {},
  services: [service],
  multiRound: { state: { key: '0123456789abcdef0123456789abcdef', principal: () => 'stdio' } },
});
