import { describe, expect, test } from 'bun:test';
import { simulateReadableStream, streamText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { AgentMessageSchema, projectAgentHistoryDetailed } from '../src/agent-runtime';

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

const at = '2026-08-26T00:00:00.000Z';
const message = (id: string, role: string, status: string, text: string) =>
  AgentMessageSchema.parse({
    schemaVersion: 1,
    id,
    conversationId: 'conversation-1',
    role,
    status,
    parts: [{ type: 'text', text }],
    createdAt: at,
    updatedAt: at,
  });

/** Hand the projection to a provider, which is the only test that counts. */
async function offerToProvider(input: {
  messages: readonly unknown[];
  instructions?: readonly string[];
}) {
  const model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'text-start', id: 't' },
          { type: 'text-delta', id: 't', delta: 'ok' },
          { type: 'text-end', id: 't' },
          { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
        ],
      } as never),
    }),
  });
  const result = streamText({
    model,
    ...(input.instructions?.length && {
      instructions: input.instructions.map((content) => ({
        role: 'system' as const,
        content,
      })),
    }),
    messages: input.messages as never,
    maxRetries: 0,
  });
  let failure: unknown;
  try {
    for await (const part of result.stream) {
      if (part.type === 'error') failure = part.error;
    }
  } catch (error) {
    failure = error;
  }
  return failure;
}

describe('a projection is only provider-valid if a provider accepts it', () => {
  test('a compacted conversation still runs', async () => {
    // `structuredCompaction` writes a `summary` message. Rendering it into
    // `messages` as a system entry made **every** subsequent run fail with
    // `provider_failure`, and the suite stayed green because the projection
    // tests asserted shape and never handed the result to a provider.
    const projected = await projectAgentHistoryDetailed([
      message('s1', 'summary', 'committed', 'earlier turns, summarised'),
      message('u1', 'user', 'committed', 'and then?'),
    ]);
    expect(projected.system).toEqual(['earlier turns, summarised']);
    expect(projected.messages.some((entry) => entry.role === 'system')).toBe(false);
    expect(await offerToProvider(projected)).toBeUndefined();
  });

  test('the system-note form of an interrupted turn still runs', async () => {
    const projected = await projectAgentHistoryDetailed(
      [
        message('u1', 'user', 'committed', 'hello'),
        message('a1', 'assistant', 'interrupted', 'we are the team, where'),
        message('u2', 'user', 'committed', 'actually'),
      ],
      { interruptedAssistant: 'system-note' },
    );
    expect(projected.system).toEqual([
      '[interrupted] partial response: we are the team, where',
    ]);
    expect(await offerToProvider(projected)).toBeUndefined();
  });

  test('a system message in the message list is what a provider refuses', async () => {
    // The guard this whole file exists for, pinned so nobody reintroduces it.
    const failure = await offerToProvider({
      messages: [
        { role: 'system', content: 'a summary' },
        { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      ],
    });
    expect(String(failure)).toContain('System messages are not allowed');
  });

  test('an ordinary conversation is unaffected', async () => {
    const projected = await projectAgentHistoryDetailed([
      message('u1', 'user', 'committed', 'hello'),
      message('a1', 'assistant', 'completed', 'hi'),
      message('u2', 'user', 'committed', 'again'),
    ]);
    expect(projected.system).toEqual([]);
    expect(await offerToProvider(projected)).toBeUndefined();
  });
});
