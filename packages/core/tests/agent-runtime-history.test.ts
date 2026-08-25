import { describe, expect, test } from 'bun:test';
import {
  AgentMessageSchema,
  projectAgentHistory,
  projectAgentHistoryDetailed,
} from '../src/agent-runtime';

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
    const user = AgentMessageSchema.parse({
      schemaVersion: 1,
      id: 'user-1',
      conversationId: 'conversation-1',
      role: 'user',
      status: 'committed',
      parts: [{ type: 'text', text: 'lookup' }],
      createdAt: '2026-08-22T00:00:00.000Z',
      updatedAt: '2026-08-22T00:00:00.000Z',
    });
    const projected = await projectAgentHistory([user, message]);
    expect(projected).toHaveLength(3);
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

    const user = AgentMessageSchema.parse({
      schemaVersion: 1,
      id: 'user-reasoning',
      conversationId: 'conversation-1',
      role: 'user',
      status: 'committed',
      parts: [{ type: 'text', text: 'think' }],
      createdAt: '2026-08-22T00:00:00.000Z',
      updatedAt: '2026-08-22T00:00:00.000Z',
    });
    const projected = await projectAgentHistory([user, draft, completed]);
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

  test('omits leading assistants and unmatched tool calls with inspectable decisions', async () => {
    const leading = AgentMessageSchema.parse({
      schemaVersion: 1,
      id: 'leading-assistant',
      conversationId: 'conversation-1',
      runId: 'run-leading',
      role: 'assistant',
      status: 'completed',
      parts: [{ type: 'text', text: 'orphan' }],
      createdAt: '2026-08-22T00:00:00.000Z',
      updatedAt: '2026-08-22T00:00:00.000Z',
    });
    const user = AgentMessageSchema.parse({
      schemaVersion: 1,
      id: 'user-tool',
      conversationId: 'conversation-1',
      role: 'user',
      status: 'committed',
      parts: [{ type: 'text', text: 'call it' }],
      createdAt: '2026-08-22T00:00:00.000Z',
      updatedAt: '2026-08-22T00:00:00.000Z',
    });
    const incomplete = AgentMessageSchema.parse({
      schemaVersion: 1,
      id: 'assistant-tool',
      conversationId: 'conversation-1',
      runId: 'run-tool',
      role: 'assistant',
      status: 'completed',
      parts: [{ type: 'tool-call', callId: 'call-1', toolName: 'lookup', input: { q: 'x' } }],
      createdAt: '2026-08-22T00:00:00.000Z',
      updatedAt: '2026-08-22T00:00:00.000Z',
    });

    const result = await projectAgentHistoryDetailed([leading, user, incomplete]);
    expect(result.messages).toHaveLength(1);
    expect(result.decisions).toEqual([
      { messageId: 'leading-assistant', action: 'omitted', reason: 'leading-assistant' },
      { messageId: 'user-tool', action: 'projected', reason: 'projected' },
      { messageId: 'assistant-tool', action: 'omitted', reason: 'incomplete-tool-turn' },
    ]);
  });
});

describe('agent history file fallbacks keep storage addresses internal', () => {
  const withFile = () =>
    AgentMessageSchema.parse({
      schemaVersion: 1,
      id: 'user-1',
      conversationId: 'conversation-1',
      role: 'user',
      status: 'completed',
      parts: [
        {
          type: 'file',
          reference: 's3://private-bucket/tenants/42/invoice.pdf',
          mediaType: 'application/pdf',
          filename: 'invoice.pdf',
        },
      ],
      createdAt: '2026-08-24T00:00:00.000Z',
      updatedAt: '2026-08-24T00:00:00.000Z',
    });

  test('the default omits an unresolved file instead of describing where it lives', async () => {
    const projected = await projectAgentHistory([withFile()]);
    expect(JSON.stringify(projected)).not.toContain('private-bucket');
    expect(JSON.stringify(projected)).not.toContain('s3://');
  });

  test('the text fallback describes the attachment, never its storage reference', async () => {
    const projected = await projectAgentHistory([withFile()], { unresolvedFile: 'text' });
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain('private-bucket');
    expect(serialized).not.toContain('s3://');
    expect(serialized).toContain('[attachment: invoice.pdf]');
  });

  test('the error fallback names the reference — it is thrown inward, not sent upstream', async () => {
    await expect(
      projectAgentHistory([withFile()], { unresolvedFile: 'error' }),
    ).rejects.toThrow('s3://private-bucket/tenants/42/invoice.pdf');
  });
});

describe('an interrupted turn does not pass as a finished one', () => {
  const at = '2026-08-25T00:00:00.000Z';
  const message = (id: string, role: string, status: string, parts: unknown[]) =>
    AgentMessageSchema.parse({
      schemaVersion: 1,
      id,
      conversationId: 'conversation-1',
      role,
      status,
      parts,
      createdAt: at,
      updatedAt: at,
    });
  const user = message('user-1', 'user', 'committed', [{ type: 'text', text: 'Hello' }]);
  const followUp = message('user-2', 'user', 'committed', [
    { type: 'text', text: 'Actually, somewhere else' },
  ]);
  const cutOff = (status: string, parts?: unknown[]) =>
    message('assistant-1', 'assistant', status, [
      { type: 'text', text: 'We are the team, where would you like' },
      ...(parts ?? []),
    ]);

  test('the default marks the fragment where a bare one used to go', async () => {
    const projected = await projectAgentHistoryDetailed([
      user,
      cutOff('interrupted'),
      followUp,
    ]);
    const assistant = projected.messages.filter((entry) => entry.role === 'assistant');
    expect(assistant).toHaveLength(1);
    expect(JSON.stringify(assistant)).toContain(
      '[interrupted: this turn was cut off before it finished]',
    );
    // Still projected — an interrupt keeps what it produced; it just stops
    // pretending the turn finished.
    expect(projected.decisions).toContainEqual({
      messageId: 'assistant-1',
      action: 'projected',
      reason: 'projected',
    });
  });

  test('the marker follows the status, not a control part that may not be there', async () => {
    // The abort path that closes the stream rather than throwing commits an
    // interrupted assistant with no control part at all.
    const withoutControl = await projectAgentHistoryDetailed([user, cutOff('interrupted')]);
    const withControl = await projectAgentHistoryDetailed([
      user,
      cutOff('interrupted', [{ type: 'control', reason: 'run-interrupted' }]),
    ]);
    expect(JSON.stringify(withoutControl.messages)).toContain('[interrupted:');
    expect(JSON.stringify(withControl.messages)).toContain('[interrupted:');
    // And the control part is now represented rather than dropped in silence.
    expect(withControl.decisions[1]).not.toHaveProperty('omittedParts');
  });

  test('a system note is context, where an assistant turn would be a commitment', async () => {
    const projected = await projectAgentHistoryDetailed(
      [user, cutOff('interrupted'), followUp],
      { interruptedAssistant: 'system-note' },
    );
    expect(projected.messages.filter((entry) => entry.role === 'assistant')).toHaveLength(0);
    const note = projected.messages.find((entry) => entry.role === 'system');
    expect(note?.content).toBe(
      '[interrupted] partial response: We are the team, where would you like',
    );
  });

  test('a system note survives the half-finished tool turn that drops an assistant one', async () => {
    const dangling = [{ type: 'tool-call', callId: 'call-1', toolName: 'lookup', input: {} }];
    const asAssistant = await projectAgentHistoryDetailed([
      user,
      cutOff('interrupted', dangling),
    ]);
    expect(asAssistant.decisions[1]).toMatchObject({
      action: 'omitted',
      reason: 'incomplete-tool-turn',
    });
    const asNote = await projectAgentHistoryDetailed([user, cutOff('interrupted', dangling)], {
      interruptedAssistant: 'system-note',
    });
    expect(asNote.messages.find((entry) => entry.role === 'system')?.content).toContain(
      '[interrupted]',
    );
    // The tool call it could not pair is named, not dropped quietly.
    expect(asNote.decisions[1]).toMatchObject({ omittedParts: ['tool-call'] });
  });

  test('omit keeps the fragment out of the request altogether', async () => {
    const projected = await projectAgentHistoryDetailed(
      [user, cutOff('interrupted'), followUp],
      { interruptedAssistant: 'omit' },
    );
    expect(JSON.stringify(projected.messages)).not.toContain('where would you like');
    expect(projected.decisions[1]).toEqual({
      messageId: 'assistant-1',
      action: 'omitted',
      reason: 'interrupted',
    });
  });

  test('a superseded turn is omitted under every setting, and says why', async () => {
    for (const interruptedAssistant of ['assistant-marked', 'system-note', 'omit'] as const) {
      const projected = await projectAgentHistoryDetailed(
        [user, cutOff('superseded'), followUp],
        { interruptedAssistant },
      );
      expect(JSON.stringify(projected.messages)).not.toContain('where would you like');
      expect(projected.decisions[1]).toEqual({
        messageId: 'assistant-1',
        action: 'omitted',
        reason: 'superseded',
      });
    }
  });

  test('a part no content stands for is recorded instead of vanishing', async () => {
    const projected = await projectAgentHistoryDetailed([
      user,
      message('assistant-2', 'assistant', 'completed', [
        { type: 'text', text: 'done' },
        { type: 'source', sourceId: 'source-1', url: 'https://example.com/' },
        {
          type: 'provider',
          envelope: { schemaVersion: 1, provider: 'test', data: { note: 'kept' } },
        },
      ]),
    ]);
    expect(projected.decisions[1]).toMatchObject({ action: 'projected' });
    expect(projected.decisions[1]?.omittedParts?.toSorted()).toEqual(['provider', 'source']);
    // A record whose parts all reached the projection carries no such list.
    expect(projected.decisions[0]).not.toHaveProperty('omittedParts');
  });

  test('an unresolved file is named as omitted rather than silently dropped', async () => {
    const projected = await projectAgentHistoryDetailed([
      message('user-3', 'user', 'committed', [
        { type: 'text', text: 'look' },
        { type: 'file', mediaType: 'image/png', reference: 'internal://bucket/key' },
      ]),
    ]);
    expect(projected.decisions[0]).toMatchObject({
      action: 'projected',
      omittedParts: ['file'],
    });
    expect(JSON.stringify(projected.messages)).not.toContain('internal://');
  });
});
