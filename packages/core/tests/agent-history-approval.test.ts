import { describe, expect, test } from 'bun:test';
import {
  type AgentMessage,
  type AgentMessagePart,
  AgentMessageSchema,
  projectAgentHistoryDetailed,
} from '../src/agent-runtime';

function record(id: string, role: AgentMessage['role'], parts: AgentMessagePart[]) {
  return AgentMessageSchema.parse({
    schemaVersion: 1,
    id,
    conversationId: 'chronology',
    role,
    status: 'committed',
    parts,
    createdAt: '2026-08-30T00:00:00.000Z',
    updatedAt: '2026-08-30T00:00:00.000Z',
  });
}

const call = (id: string): AgentMessagePart => ({
  type: 'tool-call',
  callId: id,
  toolName: id,
  input: {},
});
const request = (id: string, isAutomatic = false): AgentMessagePart => ({
  type: 'tool-approval-request',
  callId: id,
  approvalId: `approve-${id}`,
  isAutomatic,
  signature: `signature-${id}`,
});
const response = (id: string, approved = true): AgentMessagePart => ({
  type: 'tool-approval-response',
  approvalId: `approve-${id}`,
  approved,
});
const result = (id: string, outcome: 'success' | 'error' = 'success'): AgentMessagePart => ({
  type: 'tool-result',
  callId: id,
  toolName: id,
  outcome,
  output: { ok: true },
});
const user = record('user', 'user', [{ type: 'text', text: 'apply' }]);

describe('approval history chronology', () => {
  test('preserves automatic approval, result and a subsequent pending request', async () => {
    const projected = await projectAgentHistoryDetailed([
      user,
      record('automatic', 'assistant', [
        call('read'),
        request('read', true),
        response('read'),
        result('read'),
        call('write'),
        request('write'),
      ]),
    ]);
    expect(projected.decisions.map(({ action }) => action)).toEqual([
      'projected',
      'projected',
    ]);
    expect(projected.messages.map(({ role }) => role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ]);
    expect(projected.messages.at(-1)?.content).toEqual([
      { type: 'tool-call', toolCallId: 'write', toolName: 'write', input: {} },
      {
        type: 'tool-approval-request',
        toolCallId: 'write',
        approvalId: 'approve-write',
        signature: 'signature-write',
      },
    ]);
  });

  test('pairs two sequential signed continuations across canonical records', async () => {
    const projected = await projectAgentHistoryDetailed([
      user,
      record('first', 'assistant', [call('first'), request('first')]),
      record('first-answer', 'tool', [response('first')]),
      record('second', 'assistant', [result('first'), call('second'), request('second')]),
      record('second-answer', 'tool', [response('second')]),
      record('finished', 'assistant', [result('second'), { type: 'text', text: 'done' }]),
    ]);
    expect(projected.decisions.every(({ action }) => action === 'projected')).toBe(true);
    expect(projected.messages.map(({ role }) => role)).toEqual([
      'user',
      'assistant',
      'tool',
      'tool',
      'assistant',
      'tool',
      'tool',
      'assistant',
    ]);
    const parts = projected.messages.flatMap((message) =>
      message.role === 'tool' ? message.content : [],
    );
    expect(parts.filter(({ type }) => type === 'tool-result')).toEqual([
      {
        type: 'tool-result',
        toolCallId: 'first',
        toolName: 'first',
        output: { type: 'json', value: { ok: true } },
      },
      {
        type: 'tool-result',
        toolCallId: 'second',
        toolName: 'second',
        output: { type: 'json', value: { ok: true } },
      },
    ]);
  });

  const invalidCases: Array<{ name: string; parts: AgentMessagePart[] }> = [
    { name: 'unmatched result', parts: [result('absent')] },
    { name: 'duplicate result', parts: [call('read'), result('read'), result('read')] },
    { name: 'result before approval', parts: [call('read'), request('read'), result('read')] },
    { name: 'unknown approval', parts: [response('unknown')] },
    {
      name: 'duplicate response',
      parts: [
        call('read'),
        request('read'),
        response('read'),
        response('read'),
        result('read'),
      ],
    },
    { name: 'duplicate request', parts: [call('read'), request('read'), request('read')] },
    {
      name: 'successful denied result',
      parts: [call('read'), request('read'), response('read', false), result('read')],
    },
    {
      name: 'mismatched tool name',
      parts: [
        call('read'),
        { type: 'tool-result', callId: 'read', toolName: 'other', outcome: 'success' },
      ],
    },
    {
      name: 'overlapping dependent round',
      parts: [call('a'), call('b'), result('a'), call('c'), result('b'), result('c')],
    },
  ];
  for (const { name, parts } of invalidCases) {
    test(`rejects ${name} without weakening fail-closed projection`, async () => {
      const messages = [user, record('invalid', 'assistant', parts)];
      const projected = await projectAgentHistoryDetailed(messages);
      expect(projected.decisions.at(-1)).toMatchObject({
        action: 'omitted',
        reason: 'incomplete-tool-turn',
      });
      expect(projected.messages).toHaveLength(1);
      await expect(
        projectAgentHistoryDetailed(messages, { incompleteToolTurn: 'error' }),
      ).rejects.toThrow('incomplete tool chronology');
    });
  }

  test('an omitted record cannot seed calls or consume a valid pending approval', async () => {
    const projected = await projectAgentHistoryDetailed([
      user,
      record('pending', 'assistant', [call('read'), request('read')]),
      record('invalid', 'tool', [response('read'), result('absent')]),
      record('valid-answer', 'tool', [response('read')]),
      record('result', 'assistant', [result('read')]),
      record('orphan', 'assistant', [call('orphan')]),
      record('orphan-result', 'assistant', [result('orphan')]),
    ]);
    expect(projected.decisions.map(({ action }) => action)).toEqual([
      'projected',
      'projected',
      'omitted',
      'projected',
      'projected',
      'omitted',
      'omitted',
    ]);
  });

  test('ordinary reads and denied approvals retain their exact results', async () => {
    const projected = await projectAgentHistoryDetailed([
      user,
      record('read', 'assistant', [call('read'), result('read')]),
      record('deny', 'assistant', [
        call('write'),
        request('write'),
        response('write', false),
        result('write', 'error'),
      ]),
    ]);
    expect(projected.decisions.every(({ action }) => action === 'projected')).toBe(true);
    expect(JSON.stringify(projected.messages)).toContain('error-json');
  });

  test('parallel approvals remain pending until each exact result settles', async () => {
    const projected = await projectAgentHistoryDetailed([
      user,
      record('parallel', 'assistant', [call('a'), request('a'), call('b'), request('b')]),
      record('answers', 'tool', [response('a'), response('b')]),
      record('results', 'assistant', [result('b'), result('a'), call('c'), result('c')]),
    ]);
    expect(projected.decisions.every(({ action }) => action === 'projected')).toBe(true);
  });

  test('omitted failed records cannot authorize a continuation', async () => {
    const failed = {
      ...record('failed', 'assistant', [call('read'), request('read')]),
      status: 'failed',
    } satisfies AgentMessage;
    const projected = await projectAgentHistoryDetailed([
      user,
      failed,
      record('response', 'tool', [response('read')]),
      record('result', 'assistant', [result('read')]),
    ]);
    expect(projected.decisions.map(({ action }) => action)).toEqual([
      'projected',
      'omitted',
      'omitted',
      'omitted',
    ]);
  });

  test('an intervening user message does not cancel a pending approval', async () => {
    const projected = await projectAgentHistoryDetailed([
      user,
      record('request', 'assistant', [call('read'), request('read')]),
      record('next-user', 'user', [{ type: 'text', text: 'context' }]),
      record('answer', 'tool', [response('read')]),
      record('result', 'assistant', [result('read')]),
    ]);
    expect(projected.decisions.every(({ action }) => action === 'projected')).toBe(true);
  });

  test('approval state cannot cross a conversation boundary', async () => {
    const boundary = record('next-user', 'user', [{ type: 'text', text: 'new turn' }]);
    const conversationId = 'another';
    const projected = await projectAgentHistoryDetailed([
      user,
      record('request', 'assistant', [call('read'), request('read')]),
      { ...boundary, conversationId },
      { ...record('answer', 'tool', [response('read')]), conversationId },
    ]);
    expect(projected.decisions.at(-1)).toMatchObject({
      action: 'omitted',
      reason: 'incomplete-tool-turn',
    });
  });
});
