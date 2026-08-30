import { describe, expect, test } from 'bun:test';
import { resolveAgentTuiInitialConversationId } from '../src/run';

describe('Agent TUI launch identity', () => {
  test('creates a fresh conversation by default', () => {
    const first = resolveAgentTuiInitialConversationId();
    const second = resolveAgentTuiInitialConversationId();
    expect(first).toStartWith('conversation-');
    expect(second).toStartWith('conversation-');
    expect(second).not.toBe(first);
  });

  test('preserves an explicit embedding-host conversation', () => {
    expect(resolveAgentTuiInitialConversationId('known-conversation')).toBe(
      'known-conversation',
    );
  });
});
