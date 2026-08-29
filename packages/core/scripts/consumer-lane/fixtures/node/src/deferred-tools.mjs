import { createDeferredAgentToolSurface } from 'stitchkit/agent-runtime';
import { defineRuntimeTool } from 'stitchkit/tools';
import { z } from 'zod';

const calls = [];
const catalog = Array.from({ length: 32 }, (_, index) =>
  defineRuntimeTool({
    name: `packed_operation_${index}`,
    description: `Execute packed operation ${index}`,
    identity: { serviceName: 'packed', action: `operation-${index}`, method: 'POST' },
    input: z.object({ value: z.string() }),
    output: z.object({ value: z.string() }),
    handler: ({ input }) => {
      calls.push(index);
      return input;
    },
  }),
);
const preview = defineRuntimeTool({
  name: 'packed_preview',
  description: 'Render packed preview',
  identity: { serviceName: 'packed', action: 'preview', method: 'POST' },
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  handler: () => ({ ok: true }),
  present: {
    agent: () => ({
      type: 'content',
      value: [
        {
          type: 'file',
          data: { type: 'data', data: 'aGVsbG8=' },
          mediaType: 'image/png',
          filename: 'packed.png',
        },
      ],
    }),
  },
});
const deferred = createDeferredAgentToolSurface({
  runtimeTools: [...catalog, preview],
  search: {
    name: 'tool_search',
    maxQueryBytes: 128,
    maxResults: 4,
    maxResultBytes: 2_048,
  },
  activation: { maxSelectedTools: 4, maxActiveTools: 8, maxSchemaBytes: 8_192 },
});
const run = {
  schemaVersion: 1,
  id: 'packed-run',
  conversationId: 'packed-conversation',
  inputMessageIds: ['packed-input'],
  assistantMessageId: 'packed-assistant',
  state: 'running',
  revision: 1,
  ownerId: 'packed-runtime',
  createdAt: '2026-08-29T00:00:00.000Z',
  updatedAt: '2026-08-29T00:00:00.000Z',
};
const runContext = {
  context: {},
  run,
  signal: new AbortController().signal,
  toolFenceLifecycle: {},
};
const mounted = deferred.mount(runContext);
const search = mounted.tool_search?.execute;
if (!search) throw new Error('Packed deferred search was not mounted');
const receipt = await search(
  { query: 'packed_operation_31' },
  { toolCallId: 'search', messages: [], context: undefined },
);
if (calls.length !== 0 || receipt.selected?.[0] !== 'packed_operation_31') {
  throw new Error('Packed deferred search executed or selected the wrong operation');
}
const messages = [
  {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: 'search',
        toolName: 'tool_search',
        output: { type: 'json', value: receipt },
      },
    ],
  },
];
const prepare = deferred.prepareStep();
const prepared = await prepare({ ...runContext, messages, responseMessages: [] });
if (!prepared?.activeTools?.includes('packed_operation_31')) {
  throw new Error('Packed deferred selection was not reconstructed');
}
const isolated = await prepare({
  ...runContext,
  run: { ...run, id: 'packed-successor', assistantMessageId: 'packed-successor-assistant' },
  messages,
  responseMessages: [],
});
if (isolated?.activeTools?.includes('packed_operation_31')) {
  throw new Error('Packed deferred selection leaked to a successor');
}
const direct = mounted.packed_operation_31?.execute;
if (!direct) throw new Error('Packed selected direct tool was not mounted');
await direct({ value: 'ok' }, { toolCallId: 'direct', messages: [], context: undefined });
if (calls.join(',') !== '31') throw new Error('Packed direct operation identity was lost');
const presenter = mounted.packed_preview?.toModelOutput;
if (!presenter) throw new Error('Packed multimodal presenter was not retained');
const modelOutput = await presenter({
  toolCallId: 'preview',
  input: {},
  output: { ok: true },
});
if (modelOutput.type !== 'content' || modelOutput.value[0]?.type !== 'file') {
  throw new Error('Packed multimodal presenter output was lost');
}
console.log('packed deferred tools: ok');
