import { describe, expect, test } from 'bun:test';
import { isAgentTuiExitKey } from '../src/keyboard';

describe('Agent TUI keyboard lifecycle', () => {
  test('recognizes Ctrl+C in raw mode without treating plain c as exit', () => {
    expect(isAgentTuiExitKey({ name: 'c', ctrl: true })).toBe(true);
    expect(isAgentTuiExitKey({ name: 'C', ctrl: true })).toBe(true);
    expect(isAgentTuiExitKey({ name: 'c' })).toBe(false);
    expect(isAgentTuiExitKey({ name: 'escape' })).toBe(false);
  });
});
