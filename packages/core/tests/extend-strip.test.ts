import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineContract } from '../src/contract';
import { implement } from '../src/server/implement';
import { collectTools, createToolRunner, type ToolExtend } from '../src/tools/mount';

// A service where one tool is extended and another legitimately owns a param
// whose name matches the extend key (`botId`). The extend is filtered to only the
// `extended` method — so `get` is NOT extended and must keep its own `botId`.
const contract = defineContract(
  { prefix: 'bots' },
  {
    get: {
      method: 'GET',
      path: '/:botId',
      desc: 'Get a bot',
      params: z.object({ botId: z.string() }),
      output: z.object({ botId: z.string() }),
      expose: ['AGENT'],
    },
    extended: {
      method: 'POST',
      path: '/x',
      desc: 'An extended op',
      input: z.object({ name: z.string() }),
      output: z.object({ ok: z.boolean() }),
      expose: ['AGENT'],
    },
  },
);

let capturedInjected: unknown;
const service = implement(contract, {
  get: (ctx) => ({ botId: ctx.params.botId }),
  extended: (ctx) => {
    capturedInjected = ctx.injectedBotId;
    return { ok: true };
  },
});

const extend: ToolExtend = {
  schema: { botId: z.string() },
  resolve: (args) => ({ injectedBotId: args.botId }),
  filter: (_service, method) => method.key === 'extended',
};

describe('createToolRunner — extend-key strip is gated on shouldExtend', () => {
  const tools = collectTools(service, 'AGENT', { extend });
  const runTool = createToolRunner({ source: 'agent', extend });
  const getTool = tools.find((t) => t.method.key === 'get');
  const extTool = tools.find((t) => t.method.key === 'extended');

  test('a NON-extended tool keeps its own param that collides with an extend key', async () => {
    if (!getTool) throw new Error('expected get tool');
    expect(getTool.shouldExtend).toBe(false);
    const res = await runTool(getTool, { botId: 'b1' });
    // Without the fix `botId` was stripped → params validation failed → ok:false.
    expect(res.ok).toBe(true);
    expect(res.ok && res.data).toEqual({ botId: 'b1' });
  });

  test('the extended tool still strips the extend key into resolved context', async () => {
    if (!extTool) throw new Error('expected extended tool');
    expect(extTool.shouldExtend).toBe(true);
    const res = await runTool(extTool, { botId: 'ctx-b', name: 'hi' });
    expect(res.ok).toBe(true);
    // `botId` went to context via resolve, not into the handler's params/input.
    expect(capturedInjected).toBe('ctx-b');
  });
});
