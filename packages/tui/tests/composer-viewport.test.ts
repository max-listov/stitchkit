import { describe, expect, test } from 'bun:test';
import {
  createAgentTuiComposer,
  navigateAgentTuiHistory,
  setAgentTuiDraft,
  submitAgentTuiComposer,
} from '../src/composer';
import {
  createTerminalFeedViewport,
  reduceTerminalFeedViewport,
  visibleTerminalFeedRange,
} from '../src/core';

describe('Agent TUI interaction state', () => {
  test('preserves a multiline draft while navigating prompt history', () => {
    const first = submitAgentTuiComposer(
      setAgentTuiDraft(createAgentTuiComposer(), 'one\ntwo'),
    );
    const draft = setAgentTuiDraft(first.state, 'unfinished');
    const older = navigateAgentTuiHistory(draft, 'older');
    expect(older.draft).toBe('one\ntwo');
    expect(navigateAgentTuiHistory(older, 'newer').draft).toBe('unfinished');
  });

  test('stops following while reading history and counts unseen appended rows', () => {
    let viewport = createTerminalFeedViewport(100, 20);
    viewport = reduceTerminalFeedViewport(viewport, { type: 'page', pages: -1 });
    viewport = reduceTerminalFeedViewport(viewport, { type: 'append', count: 3 });
    expect(viewport.unseen).toBe(3);
    expect(visibleTerminalFeedRange(viewport)).toEqual({ start: 60, end: 80 });
    expect(reduceTerminalFeedViewport(viewport, { type: 'end' }).unseen).toBe(0);
  });
});
