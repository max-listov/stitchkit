/**
 * Guard: which records may be summarised away is answerable without a store.
 *
 * Two consuming applications wrote a compactor apiece — 387 and 475 lines,
 * independently evolved — because ours was reachable only through
 * `structuredCompaction`, which takes a runtime store and writes back under a
 * version check. The selection inside it never needed either (→ ADR 0142).
 *
 * The property both hand-written compactors are one mistake away from: a turn
 * is cut whole and only once it is complete. Half a turn hands the provider a
 * tool call with no result, which most of them refuse outright.
 */
import { describe, expect, test } from 'bun:test';
import {
  type AgentMessage,
  AgentMessageSchema,
  selectCompactableHistory,
} from '../src/agent-runtime';

const timestamp = '2026-09-01T00:00:00.000Z';
let sequence = 0;

function message(
  role: AgentMessage['role'],
  parts: AgentMessage['parts'],
  status: AgentMessage['status'] = 'committed',
): AgentMessage {
  sequence += 1;
  return AgentMessageSchema.parse({
    schemaVersion: 1,
    id: `message-${sequence}`,
    conversationId: 'conversation-1',
    role,
    status,
    parts,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

/** One question answered — the shape every eligible turn has. */
function completeTurn(index: number): AgentMessage[] {
  return [
    message('user', [{ type: 'text', text: `question ${index}` }]),
    message('assistant', [{ type: 'text', text: `answer ${index}` }], 'completed'),
  ];
}

/** A question whose tool call never came back. */
function danglingToolTurn(index: number): AgentMessage[] {
  return [
    message('user', [{ type: 'text', text: `question ${index}` }]),
    message(
      'assistant',
      [{ type: 'tool-call', callId: `call-${index}`, toolName: 'search', input: {} }],
      'completed',
    ),
  ];
}

describe('selecting compactable history without a store', () => {
  test('the oldest whole turns are compactable and the recent ones are kept', () => {
    const [first, second, third] = [completeTurn(1), completeTurn(2), completeTurn(3)];
    const messages = [...first, ...second, ...third];
    const selected = selectCompactableHistory({ messages, keepRecentTurns: 1 });
    expect(selected.compactable).toEqual([...first, ...second]);
    expect(selected.retained).toEqual(third);
    // Together they are the input, in order: nothing is dropped and nothing is
    // counted twice.
    expect([...selected.compactable, ...selected.retained]).toEqual(messages);
  });

  test('a turn is never cut in half', () => {
    // `keepRecentTurns` counts turns, not messages, so no setting of it can
    // land the boundary inside one.
    const messages = [...completeTurn(1), ...completeTurn(2), ...completeTurn(3)];
    for (const keepRecentTurns of [0, 1, 2, 3, 4]) {
      const { compactable } = selectCompactableHistory({ messages, keepRecentTurns });
      expect(compactable.length % 2).toBe(0);
      if (compactable.length > 0) expect(compactable[0]?.role).toBe('user');
    }
  });

  test('an unanswered tool call is never eligible, and neither is anything after it', () => {
    // A call with no result is not evidence of anything: summarising it away
    // hides an unfinished exchange, and the turns behind it are only meaningful
    // in its company.
    const [answered, dangling, after] = [
      completeTurn(1),
      danglingToolTurn(2),
      completeTurn(3),
    ];
    const messages = [...answered, ...dangling, ...after];
    const selected = selectCompactableHistory({ messages, keepRecentTurns: 0 });
    expect(selected.compactable).toEqual(answered);
    expect(selected.retained).toEqual([...dangling, ...after]);
  });

  test('an existing summary is reported, not compacted again', () => {
    // A caller that appends a second summary instead of replacing the first
    // grows a chain of summaries of summaries.
    const summary = message('summary', [{ type: 'text', text: 'what came before' }]);
    const [first, second] = [completeTurn(1), completeTurn(2)];
    const selected = selectCompactableHistory({
      messages: [summary, ...first, ...second],
      keepRecentTurns: 1,
    });
    expect(selected.leadingSummary?.id).toBe(summary.id);
    // The summary is neither compacted again nor retained as ordinary history:
    // a caller replaces it, and stacking a summary of a summary is the shape
    // that turns a long conversation into a rumour.
    expect(selected.compactable).toEqual(first);
    expect(selected.retained).toEqual(second);
  });

  test('nothing eligible is an empty selection, not an error', () => {
    expect(selectCompactableHistory({ messages: [], keepRecentTurns: 2 }).compactable).toEqual(
      [],
    );
    const one = selectCompactableHistory({ messages: completeTurn(1), keepRecentTurns: 2 });
    expect(one.compactable).toEqual([]);
    expect(one.retained.length).toBe(2);
  });

  test('a nonsensical retention count is refused rather than interpreted', () => {
    for (const keepRecentTurns of [-1, 1.5, Number.NaN]) {
      expect(() => selectCompactableHistory({ messages: [], keepRecentTurns })).toThrow(
        TypeError,
      );
    }
  });
});
