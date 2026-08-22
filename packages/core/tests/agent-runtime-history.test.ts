import { describe, expect, test } from 'bun:test';
import { AgentMessageSchema, projectAgentHistory } from '../src/agent-runtime';

describe('agent history projection', () => {
  test('round-trips provider-required tool-call metadata into AI SDK messages', async () => {
    const message = AgentMessageSchema.parse({
      schemaVersion: 1,
      id: 'assistant-1',
      conversationId: 'conversation-1',
      runId: 'run-1',
      role: 'assistant',
      status: 'completed',
      parts: [
        {
          type: 'tool-call',
          callId: 'call-1',
          toolName: 'lookup',
          input: { q: 'value' },
          provider: {
            schemaVersion: 1,
            provider: 'ai-sdk',
            data: { google: { thought_signature: 'signature' } },
          },
        },
        {
          type: 'tool-result',
          callId: 'call-1',
          toolName: 'lookup',
          outcome: 'success',
          output: { ok: true },
        },
      ],
      createdAt: '2026-08-22T00:00:00.000Z',
      updatedAt: '2026-08-22T00:00:00.000Z',
    });
    const projected = await projectAgentHistory([message]);
    expect(projected).toHaveLength(2);
    expect(JSON.stringify(projected)).toContain('thought_signature');
  });

  test('excludes crash drafts while preserving completed reasoning metadata', async () => {
    const shared = {
      schemaVersion: 1,
      conversationId: 'conversation-1',
      runId: 'run-1',
      role: 'assistant',
      createdAt: '2026-08-22T00:00:00.000Z',
      updatedAt: '2026-08-22T00:00:00.000Z',
    };
    const draft = AgentMessageSchema.parse({
      ...shared,
      id: 'draft-1',
      status: 'streaming',
      parts: [{ type: 'text', text: 'partial' }],
    });
    const completed = AgentMessageSchema.parse({
      ...shared,
      id: 'assistant-2',
      status: 'completed',
      parts: [
        {
          type: 'reasoning',
          text: 'reasoning',
          provider: {
            schemaVersion: 1,
            provider: 'ai-sdk',
            data: { google: { thought_signature: 'exact-signature' } },
          },
        },
      ],
    });

    const projected = await projectAgentHistory([draft, completed]);
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain('partial');
    expect(serialized).toContain('exact-signature');
  });

  test('resolves durable image references into real multimodal file parts', async () => {
    const message = AgentMessageSchema.parse({
      schemaVersion: 1,
      id: 'user-image',
      conversationId: 'conversation-1',
      role: 'user',
      status: 'committed',
      parts: [
        { type: 'text', text: 'What is shown?' },
        { type: 'file', mediaType: 'image/png', reference: 'object:image-1' },
      ],
      createdAt: '2026-08-22T00:00:00.000Z',
      updatedAt: '2026-08-22T00:00:00.000Z',
    });

    const projected = await projectAgentHistory([message], {
      resolveFile: () => ({ type: 'url', url: new URL('https://example.com/image.png') }),
    });

    expect(projected[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'What is shown?' },
        {
          type: 'file',
          data: { type: 'url', url: new URL('https://example.com/image.png') },
          mediaType: 'image/png',
        },
      ],
    });
  });
});
