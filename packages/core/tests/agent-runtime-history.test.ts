import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  AgentMessageSchema,
  projectAgentHistory,
  projectAgentHistoryDetailed,
} from '../src/entrypoints/agent-runtime';
import {
  defineAgentTool,
  defineViewFileTool,
  mountAgentTools,
} from '../src/entrypoints/tools';

describe('agent history projection', () => {
  test('opts failed terminal evidence in with an explicit non-success marker', async () => {
    const user = AgentMessageSchema.parse({
      schemaVersion: 1,
      id: 'failed-user',
      conversationId: 'failed-conversation',
      role: 'user',
      status: 'committed',
      parts: [{ type: 'text', text: 'inspect' }],
      createdAt: '2026-08-30T00:00:00.000Z',
      updatedAt: '2026-08-30T00:00:00.000Z',
    });
    const failed = AgentMessageSchema.parse({
      schemaVersion: 1,
      id: 'failed-assistant',
      conversationId: 'failed-conversation',
      runId: 'failed-run',
      role: 'assistant',
      status: 'failed',
      parts: [{ type: 'text', text: 'The decisive finding survived.' }],
      createdAt: '2026-08-30T00:00:01.000Z',
      updatedAt: '2026-08-30T00:00:01.000Z',
    });
    expect(await projectAgentHistory([user, failed])).toHaveLength(1);
    const projected = await projectAgentHistory([user, failed], {
      evidencePolicy: { failedAssistant: 'assistant-marked' },
    });
    expect(JSON.stringify(projected)).toContain('The decisive finding survived.');
    expect(JSON.stringify(projected)).toContain('did not complete successfully');
  });

  test('fails closed when opted-in failed evidence has incomplete tool chronology', async () => {
    const at = '2026-08-30T00:00:00.000Z';
    const user = AgentMessageSchema.parse({
      schemaVersion: 1,
      id: 'failed-tool-user',
      conversationId: 'failed-tool-conversation',
      role: 'user',
      status: 'committed',
      parts: [{ type: 'text', text: 'inspect' }],
      createdAt: at,
      updatedAt: at,
    });
    const failed = AgentMessageSchema.parse({
      schemaVersion: 1,
      id: 'failed-tool-assistant',
      conversationId: 'failed-tool-conversation',
      runId: 'failed-tool-run',
      role: 'assistant',
      status: 'failed',
      parts: [{ type: 'tool-call', callId: 'uncertain', toolName: 'effect', input: {} }],
      createdAt: at,
      updatedAt: at,
    });
    const projected = await projectAgentHistoryDetailed([user, failed], {
      evidencePolicy: { failedAssistant: 'assistant-marked' },
    });
    expect(projected.messages).toHaveLength(1);
    expect(projected.decisions[1]).toMatchObject({
      action: 'omitted',
      reason: 'incomplete-tool-turn',
    });
  });

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

  test('preserves dependent tool rounds and trailing final text in causal order', async () => {
    const user = AgentMessageSchema.parse({
      schemaVersion: 1,
      id: 'user-rounds',
      conversationId: 'conversation-rounds',
      role: 'user',
      status: 'committed',
      parts: [{ type: 'text', text: 'research' }],
      createdAt: '2026-08-22T00:00:00.000Z',
      updatedAt: '2026-08-22T00:00:00.000Z',
    });
    const assistant = AgentMessageSchema.parse({
      schemaVersion: 1,
      id: 'assistant-rounds',
      conversationId: 'conversation-rounds',
      runId: 'run-rounds',
      role: 'assistant',
      status: 'completed',
      parts: [
        { type: 'tool-call', callId: 'a', toolName: 'lookup', input: { query: 'first' } },
        {
          type: 'tool-call',
          callId: 'parallel',
          toolName: 'lookup',
          input: { query: 'peer' },
        },
        {
          type: 'tool-result',
          callId: 'a',
          toolName: 'lookup',
          outcome: 'success',
          output: { value: 1 },
        },
        {
          type: 'tool-result',
          callId: 'parallel',
          toolName: 'lookup',
          outcome: 'success',
          output: { value: 2 },
        },
        {
          type: 'tool-call',
          callId: 'b',
          toolName: 'lookup',
          input: { from: 1 },
        },
        {
          type: 'tool-result',
          callId: 'b',
          toolName: 'lookup',
          outcome: 'success',
          output: { value: 3 },
        },
        { type: 'text', text: 'final answer' },
      ],
      createdAt: '2026-08-22T00:00:00.000Z',
      updatedAt: '2026-08-22T00:00:00.000Z',
    });

    const projected = await projectAgentHistory([user, assistant]);
    expect(projected.map((entry) => entry.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
      'tool',
      'assistant',
    ]);
    expect(JSON.stringify(projected[1])).toContain('parallel');
    expect(JSON.stringify(projected[3])).toContain('"b"');
    expect(JSON.stringify(projected[5])).toContain('final answer');
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
    // Into the provider's instructions channel, never into `messages`: `ai`
    // refuses a system-role entry there, so putting it in the message list made
    // this mode fail the run outright rather than merely say nothing useful.
    expect(projected.messages.filter((entry) => entry.role === 'system')).toHaveLength(0);
    expect(projected.system).toEqual([
      '[interrupted] partial response: We are the team, where would you like',
    ]);
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
    expect(asNote.system[0]).toContain('[interrupted]');
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

describe('assistant file parts and multimodal tool-result projection across turns', () => {
  const at = '2026-11-28T00:00:00.000Z';
  const user = AgentMessageSchema.parse({
    schemaVersion: 1,
    id: 'user-mm-1',
    conversationId: 'conv-mm',
    role: 'user',
    status: 'committed',
    parts: [{ type: 'text', text: 'Inspect and generate image' }],
    createdAt: at,
    updatedAt: at,
  });

  test('projects persisted assistant file parts through resolveFile and respects unresolvedFile fallbacks', async () => {
    const assistant = AgentMessageSchema.parse({
      schemaVersion: 1,
      id: 'assistant-file-1',
      conversationId: 'conv-mm',
      runId: 'run-mm-1',
      role: 'assistant',
      status: 'completed',
      parts: [
        { type: 'text', text: 'Generated preview:' },
        {
          type: 'file',
          mediaType: 'image/png',
          reference: 's3://private-bucket/generated/chart.png',
          filename: 'chart.png',
        },
      ],
      createdAt: at,
      updatedAt: at,
    });

    const resolved = await projectAgentHistoryDetailed([user, assistant], {
      resolveFile: () => ({ type: 'url', url: new URL('https://cdn.example.com/chart.png') }),
    });
    expect(resolved.decisions[1]).toEqual({
      messageId: 'assistant-file-1',
      action: 'projected',
      reason: 'projected',
    });
    expect(resolved.messages[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'Generated preview:' },
        {
          type: 'file',
          data: { type: 'url', url: new URL('https://cdn.example.com/chart.png') },
          mediaType: 'image/png',
          filename: 'chart.png',
        },
      ],
    });

    // Default omit records omittedParts and never leaks storage reference.
    const omitted = await projectAgentHistoryDetailed([user, assistant]);
    expect(omitted.decisions[1]).toMatchObject({
      action: 'projected',
      omittedParts: ['file'],
    });
    expect(JSON.stringify(omitted.messages)).not.toContain('private-bucket');

    // Text fallback describes attachment without leaking storage reference.
    const placeholder = await projectAgentHistory([user, assistant], {
      unresolvedFile: 'text',
    });
    expect(JSON.stringify(placeholder)).toContain('[attachment: chart.png]');
    expect(JSON.stringify(placeholder)).not.toContain('private-bucket');

    // Error fallback throws inward naming the reference.
    await expect(
      projectAgentHistory([user, assistant], { unresolvedFile: 'error' }),
    ).rejects.toThrow('s3://private-bucket/generated/chart.png');
  });

  test('projects persisted multimodal tool results via mounted tools (defineViewFileTool) and resolveToolModelOutput', async () => {
    const sampleBytes = new Uint8Array([1, 2, 3]);
    const viewTool = defineViewFileTool({
      description: 'View image',
      identity: { serviceName: 'media', action: 'view', scope: 'user' },
      files: {
        read: async (path) => ({
          ref: { path, mediaType: 'image/png', size: sampleBytes.byteLength },
          bytes: sampleBytes,
        }),
        write: async (path) => ({ path, size: 0 }),
      },
    });
    const tools = mountAgentTools([], {
      access: { open: 'local-operator' },
      runtimeTools: [viewTool],
    });
    const customTool = defineAgentTool({
      input: z.object({ id: z.string() }),
      execute: async () => ({ label: 'ok' }),
      toModelOutput: ({ input, output }) => ({
        type: 'text',
        value: `${input.id}:${output.label}`,
      }),
    });

    const assistant = AgentMessageSchema.parse({
      schemaVersion: 1,
      id: 'assistant-mm-tool',
      conversationId: 'conv-mm',
      runId: 'run-mm-2',
      role: 'assistant',
      status: 'completed',
      parts: [
        {
          type: 'tool-call',
          callId: 'vf-1',
          toolName: 'view_file',
          input: { paths: ['a.png'] },
        },
        {
          type: 'tool-result',
          callId: 'vf-1',
          toolName: 'view_file',
          outcome: 'success',
          output: {
            content: [{ type: 'image', data: 'AQID', mimeType: 'image/png' }],
            errors: [],
          },
        },
        { type: 'tool-call', callId: 'c-1', toolName: 'custom_view', input: { id: 'item-7' } },
        {
          type: 'tool-result',
          callId: 'c-1',
          toolName: 'custom_view',
          outcome: 'success',
          output: { label: 'ok' },
        },
        {
          type: 'tool-call',
          callId: 'e-1',
          toolName: 'view_file',
          input: { paths: ['missing'] },
        },
        {
          type: 'tool-result',
          callId: 'e-1',
          toolName: 'view_file',
          outcome: 'error',
          output: { message: 'Not found' },
        },
      ],
      createdAt: at,
      updatedAt: at,
    });

    const projected = await projectAgentHistory([user, assistant], {
      tools: { ...tools, custom_view: customTool },
    });
    const toolMessages = projected.filter((m) => m.role === 'tool');
    expect(toolMessages).toHaveLength(3);
    expect(toolMessages[0]?.content[0]).toEqual({
      type: 'tool-result',
      toolCallId: 'vf-1',
      toolName: 'view_file',
      output: {
        type: 'content',
        value: [
          { type: 'file', data: { type: 'data', data: 'AQID' }, mediaType: 'image/png' },
        ],
      },
    });
    expect(toolMessages[1]?.content[0]).toEqual({
      type: 'tool-result',
      toolCallId: 'c-1',
      toolName: 'custom_view',
      output: { type: 'text', value: 'item-7:ok' },
    });
    // Failed tool results stay error-json instead of calling toModelOutput.
    expect(toolMessages[2]?.content[0]).toEqual({
      type: 'tool-result',
      toolCallId: 'e-1',
      toolName: 'view_file',
      output: { type: 'error-json', value: { message: 'Not found' } },
    });

    // Custom resolveToolModelOutput override wins when returning a non-undefined value.
    const overridden = await projectAgentHistory([user, assistant], {
      resolveToolModelOutput: ({ toolCallId }) =>
        toolCallId === 'vf-1' ? { type: 'text', value: 'overridden-view' } : undefined,
    });
    const overriddenTool = overridden.find((m) => m.role === 'tool');
    expect(overriddenTool?.content[0]).toMatchObject({
      toolCallId: 'vf-1',
      output: { type: 'text', value: 'overridden-view' },
    });
  });
});
