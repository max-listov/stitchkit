import { describe, expect, test } from 'bun:test';
import {
  type AgentHistoryEvidencePolicy,
  type AgentMessage,
  AgentMessageSchema,
  projectAgentHistoryDetailed,
  selectCompactableHistory,
} from '../src/entrypoints/agent-runtime';

const at = '2026-10-25T00:00:00.000Z';
const evidencePolicy: AgentHistoryEvidencePolicy = { failedAssistant: 'assistant-marked' };

function message(
  id: string,
  role: AgentMessage['role'],
  status: AgentMessage['status'],
  parts: AgentMessage['parts'],
): AgentMessage {
  return AgentMessageSchema.parse({
    schemaVersion: 1,
    id,
    conversationId: 'failed-compaction',
    role,
    status,
    parts,
    createdAt: at,
    updatedAt: at,
  });
}

function turn(id: string, status: AgentMessage['status'], parts: AgentMessage['parts']) {
  return [
    message(`user-${id}`, 'user', 'committed', [{ type: 'text', text: id }]),
    message(`assistant-${id}`, 'assistant', status, parts),
  ];
}

const complete = (id: string) => turn(id, 'completed', [{ type: 'text', text: 'done' }]);
const call: AgentMessage['parts'][number] = {
  type: 'tool-call',
  callId: 'effect',
  toolName: 'send',
  input: {},
};
const result: AgentMessage['parts'][number] = {
  type: 'tool-result',
  callId: 'effect',
  toolName: 'send',
  outcome: 'error',
  output: { code: 'UNKNOWN' },
};

describe('explicit failed compaction evidence', () => {
  for (const parts of [
    [],
    [{ type: 'control', reason: 'stale-run' }],
  ] satisfies AgentMessage['parts'][]) {
    test(`empty failure keeps its non-success marker (${parts.length} parts)`, async () => {
      const failed = turn('first', 'failed', parts);
      expect((await projectAgentHistoryDetailed(failed)).messages).toHaveLength(1);
      const projected = await projectAgentHistoryDetailed(failed, { evidencePolicy });
      expect(projected.messages).toHaveLength(2);
      expect(JSON.stringify(projected.messages[1])).toContain('did not complete successfully');
      expect(projected.decisions[1]).toMatchObject({
        action: 'projected',
        reason: 'projected',
      });
    });
  }

  test('opt-in releases the complete failed prefix and keeps the newest turn', () => {
    const failed = turn('first', 'failed', []);
    const second = complete('second');
    const recent = complete('recent');
    const messages = [...failed, ...second, ...recent];
    expect(selectCompactableHistory({ messages, keepRecentTurns: 1 }).compactable).toEqual([]);
    expect(selectCompactableHistory({ messages, keepRecentTurns: 1, evidencePolicy })).toEqual(
      {
        compactable: [...failed, ...second],
        retained: recent,
      },
    );
    expect(messages[1]?.status).toBe('failed');
  });

  test('a matched UNKNOWN result closes chronology without asserting effect success', async () => {
    const failed = turn('first', 'failed', [call, result]);
    expect(
      selectCompactableHistory({ messages: failed, keepRecentTurns: 0, evidencePolicy })
        .compactable,
    ).toEqual(failed);
    const projected = await projectAgentHistoryDetailed(failed, {
      evidencePolicy,
      incompleteToolTurn: 'error',
    });
    expect(JSON.stringify(projected.messages)).toContain('UNKNOWN');
    expect(JSON.stringify(projected.messages)).toContain('error-json');
    expect(JSON.stringify(projected.messages)).toContain('did not complete successfully');
  });

  test('unresolved, invalid and rejected approval exchanges retain the whole suffix', () => {
    const request: AgentMessage['parts'][number] = {
      type: 'tool-approval-request',
      callId: 'effect',
      approvalId: 'approval',
    };
    const denied: AgentMessage['parts'][number] = {
      type: 'tool-approval-response',
      approvalId: 'approval',
      approved: false,
    };
    const invalid: AgentMessage['parts'][] = [
      [call],
      [result],
      [call, request],
      [call, request, result],
      [call, { ...result, callId: 'other' }],
      [call, result, result],
      [call, request, denied, { ...result, outcome: 'success' }],
    ];
    for (const parts of invalid) {
      const messages = [...turn('first', 'failed', parts), ...complete('later')];
      expect(
        selectCompactableHistory({ messages, keepRecentTurns: 0, evidencePolicy }),
      ).toEqual({ compactable: [], retained: messages });
    }
  });

  test('truly incomplete and unspeakable turns stay barriers even with opt-in', () => {
    for (const first of [
      [message('unanswered', 'user', 'committed', [{ type: 'text', text: 'pending' }])],
      turn('draft', 'streaming', []),
      turn('discarded', 'superseded', []),
    ]) {
      const messages = [...first, ...complete('later')];
      expect(
        selectCompactableHistory({ messages, keepRecentTurns: 0, evidencePolicy }).compactable,
      ).toEqual([]);
    }
  });

  test('empty interrupted projection retains its existing omission', async () => {
    const projected = await projectAgentHistoryDetailed(turn('cut', 'interrupted', []), {
      evidencePolicy,
    });
    expect(projected.messages).toHaveLength(1);
    expect(projected.decisions[1]).toMatchObject({ action: 'omitted', reason: 'empty' });
  });
});
