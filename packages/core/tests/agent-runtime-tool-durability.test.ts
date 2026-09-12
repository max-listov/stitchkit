import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import {
  createAgentRuntime,
  createMemoryAgentRuntimeStore,
  defineAgentProtocol,
} from '../src/agent-runtime';
import { defineRuntimeTool, mountAgent } from '../src/tools';

test('a separate process resumes the runtime without repeating a recorded effect', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stitchkit-durable-restart-'));
  try {
    const run = async (phase: string) => {
      const process = Bun.spawn(
        [
          Bun.which('bun') ?? 'bun',
          join(import.meta.dir, 'fixtures/durability-restart.ts'),
          join(root, 'state.sqlite'),
          join(root, 'effects'),
          phase,
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      );
      const [code, stderr] = await Promise.all([
        process.exited,
        new Response(process.stderr).text(),
      ]);
      if (code !== 0 && code !== 77) throw new Error(stderr);
      return code;
    };
    expect(await run('crash')).toBe(77);
    expect(await readFile(join(root, 'effects'), 'utf8')).toBe('first\n');
    expect(await run('resume')).toBe(0);
    expect(await readFile(join(root, 'effects'), 'utf8')).toBe('first\nsecond\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('runtime supplies durability through SDK context to the mounted handler', async () => {
  const store = createMemoryAgentRuntimeStore();
  let effects = 0;
  let handlers = 0;
  const effect = defineRuntimeTool({
    name: 'effect',
    description: 'Record an effect',
    identity: { serviceName: 'test', action: 'effect', method: 'POST' },
    input: z.object({}),
    output: z.object({ receipt: z.number() }),
    handler: async (context) => {
      handlers++;
      if (!context.step || !context.sleep || !context.waitFor)
        throw new Error('durability context missing');
      const receipt = await context.step('write', () => ++effects);
      expect(await context.step('write', () => ++effects)).toBe(receipt);
      return { receipt };
    },
  });
  const model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'tool-call', toolCallId: 'effect-1', toolName: 'effect', input: '{}' },
          {
            type: 'finish',
            finishReason: { unified: 'tool-calls', raw: undefined },
            usage: {
              inputTokens: {
                total: 1,
                noCache: 1,
                cacheRead: undefined,
                cacheWrite: undefined,
              },
              outputTokens: { total: 1, text: 1, reasoning: undefined },
            },
          },
        ],
      }),
    }),
  });
  const runtime = createAgentRuntime({
    protocol: defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}) }),
    store,
    durability: true,
    models: {
      resolve: () => ({
        descriptor: {
          provider: 'test',
          modelId: 'durable',
          contextWindow: 4096,
          capabilities: [],
        },
        model,
      }),
    },
    prompt: () => ({
      instructions: 'Test',
      instructionTokens: { value: 1, provenance: 'computed' },
      contextDecision: 'fits',
      availableHistoryTokens: 1000,
      sections: [],
    }),
    tools: () => mountAgent([], { runtimeTools: [effect] }),
    loop: { maxSteps: 1 },
  });
  try {
    await runtime.submit({
      conversationId: 'durable',
      idempotencyKey: 'one',
      context: {},
      parts: [{ type: 'text', text: 'run' }],
      metadata: {},
    }).result;
    expect({ handlers, effects }).toEqual({ handlers: 1, effects: 1 });
    const events = await store.readEvents({ conversationId: 'durable', limit: 100 });
    expect(events.items.filter((event) => event.kind === 'durability/step')).toHaveLength(1);
  } finally {
    await runtime.close();
  }
});
