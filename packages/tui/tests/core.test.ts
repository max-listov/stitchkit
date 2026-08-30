import { describe, expect, test } from 'bun:test';
import {
  createTerminalCollection,
  createTerminalCommandPalette,
  createTerminalFeedViewport,
  createTerminalOperationState,
  createTerminalPaneState,
  moveTerminalCommandSelection,
  reduceTerminalCollection,
  reduceTerminalFeedViewport,
  reduceTerminalOperationState,
  reduceTerminalPaneState,
  resolveExactTerminalCommand,
  setTerminalCommandQuery,
  terminalCommandMatches,
  validateTerminalCommands,
  visibleTerminalCollectionRange,
  visibleTerminalPanes,
} from '../src/core';

describe('renderer-neutral terminal core', () => {
  test('keeps live collection selection attached to its identity across reorder', () => {
    let state = createTerminalCollection(['a', 'b', 'c', 'd'], 2, 'c');
    state = reduceTerminalCollection(state, {
      type: 'reconcile',
      keys: ['c', 'a', 'd', 'b'],
    });
    expect(state.selectedKey).toBe('c');
    expect(visibleTerminalCollectionRange(state)).toEqual({ start: 0, end: 2 });
  });

  test('selects the nearest survivor and rejects duplicate identities', () => {
    let state = createTerminalCollection(['a', 'b', 'c'], 2, 'b');
    state = reduceTerminalCollection(state, { type: 'reconcile', keys: ['a', 'c'] });
    expect(state.selectedKey).toBe('c');
    expect(() => createTerminalCollection(['a', 'a'], 1)).toThrow(/unique/);
  });

  test('tracks unseen feed rows until the reader returns to the tail', () => {
    let state = createTerminalFeedViewport(20, 5);
    state = reduceTerminalFeedViewport(state, { type: 'page', pages: -1 });
    state = reduceTerminalFeedViewport(state, { type: 'append', count: 2 });
    expect(state).toMatchObject({ followTail: false, unseen: 2, start: 10 });
    expect(reduceTerminalFeedViewport(state, { type: 'end' })).toMatchObject({
      followTail: true,
      unseen: 0,
      start: 17,
    });
  });

  test('bounds split panes and collapses to the focused pane when space disappears', () => {
    let state = createTerminalPaneState({
      totalSize: 120,
      primarySize: 70,
      minPrimary: 40,
      minSecondary: 30,
      focus: 'secondary',
    });
    state = reduceTerminalPaneState(state, { type: 'resize', primarySize: 110 });
    expect(state.primarySize).toBe(90);
    state = reduceTerminalPaneState(state, { type: 'terminal-resize', totalSize: 60 });
    expect(visibleTerminalPanes(state)).toEqual(['secondary']);
  });

  test('filters and navigates commands but dispatches only an exact name or alias', () => {
    const commands = validateTerminalCommands([
      { id: 'model', aliases: ['mo'], label: 'Choose model', description: 'Models' },
      { id: 'move', aliases: [], label: 'Move item', description: 'Move' },
    ]);
    let state = setTerminalCommandQuery(createTerminalCommandPalette(), 'mo');
    expect(terminalCommandMatches(state, commands).map(({ id }) => id)).toEqual([
      'model',
      'move',
    ]);
    state = moveTerminalCommandSelection(state, 1, 2);
    expect(state.selectedIndex).toBe(1);
    expect(resolveExactTerminalCommand('mo', commands)?.id).toBe('model');
    expect(resolveExactTerminalCommand('m', commands)).toBeUndefined();
    const duplicate = commands[0];
    if (!duplicate) throw new Error('command fixture is empty');
    expect(() => validateTerminalCommands([...commands, duplicate])).toThrow(/collides/);
  });

  test('serializes one confirmed operation and refuses invalid transitions', () => {
    let state = reduceTerminalOperationState(createTerminalOperationState(), {
      type: 'request',
      operationId: 'restart:a',
    });
    state = reduceTerminalOperationState(state, { type: 'confirm' });
    expect(() =>
      reduceTerminalOperationState(state, { type: 'request', operationId: 'delete:a' }),
    ).toThrow(/pending/);
    state = reduceTerminalOperationState(state, { type: 'succeed', message: 'ready' });
    expect(state).toEqual({
      status: 'succeeded',
      operationId: 'restart:a',
      message: 'ready',
    });
  });
});
