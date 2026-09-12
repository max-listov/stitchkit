import { appendFile } from 'node:fs/promises';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import { createAgentRuntime, defineAgentProtocol } from '../../src/agent-runtime';
import { createBunSqliteAgentRuntimeStore } from '../../src/agent-runtime-sqlite-bun';
import { defineRuntimeTool, mountAgent } from '../../src/tools';

const [filename, effects, phase] = process.argv.slice(2);
if (!filename || !effects) throw new Error('fixture requires paths');
const durable = createBunSqliteAgentRuntimeStore({ filename });
const effect = defineRuntimeTool({
  name: 'effect',
  description: 'Durable work',
  identity: { serviceName: 'test', action: 'effect', method: 'POST' },
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  handler: async ({ step }) => {
    if (!step) throw new Error('missing step context');
    await step('first', async () => {
      await appendFile(effects, 'first\n');
      return true;
    });
    if (phase === 'crash') process.exit(77);
    await step('second', async () => {
      await appendFile(effects, 'second\n');
      return true;
    });
    return { ok: true };
  },
});
const model = new MockLanguageModelV4({
  doStream: async () => ({
    stream: simulateReadableStream({
      chunks: [
        { type: 'tool-call', toolCallId: 'stable-call', toolName: 'effect', input: '{}' },
        {
          type: 'finish',
          finishReason: { unified: 'tool-calls', raw: undefined },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 1, text: 1, reasoning: undefined },
          },
        },
      ],
    }),
  }),
});
const runtime = createAgentRuntime({
  protocol: defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}) }),
  store: durable.store,
  durability: true,
  models: {
    resolve: () => ({
      descriptor: {
        provider: 'test',
        modelId: 'restart',
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
    sections: [],
  }),
  tools: () => mountAgent([], { runtimeTools: [effect] }),
  loop: { maxSteps: 1 },
});
try {
  if (phase === 'crash')
    await runtime.submit({
      conversationId: 'restart',
      idempotencyKey: 'one',
      context: {},
      parts: [{ type: 'text', text: 'work' }],
      metadata: {},
    }).result;
  else {
    // The parent has observed the former process exit. This host owns recovery.
    const outcomes = await runtime.recover({
      resolveContext: () => ({}),
      decide: () => ({ action: 'requeue', replaySafe: true }),
    });
    if (outcomes.length !== 1 || outcomes[0]?.outcome !== 'requeued')
      throw new Error('recovery failed');
    await outcomes[0].result;
  }
} finally {
  await runtime.close();
  await durable.close();
}
