import { describe, expect, test } from 'bun:test';
import { createAgentTuiBuiltinCommands } from '../src/builtins';
import {
  commandCompletions,
  composeTuiCommands,
  moveCommandCompletionSelection,
  resolveTuiCommand,
  resolveTuiCommandSubmission,
  selectedCommandCompletion,
} from '../src/commands';

describe('Agent TUI commands', () => {
  const commands = createAgentTuiBuiltinCommands();

  test('resolves built-ins and leaves unknown slash input as a model prompt', () => {
    expect(resolveTuiCommand('/model', commands).type).toBe('command');
    expect(resolveTuiCommand('/?', commands).type).toBe('command');
    expect(resolveTuiCommand('/make-this-real', commands)).toEqual({
      type: 'prompt',
      text: '/make-this-real',
    });
  });

  test('offers bounded prefix completions before arguments begin', () => {
    expect(commandCompletions('/mo', commands).map(({ name }) => name)).toEqual(['model']);
    expect(commandCompletions('/model ', commands)).toEqual([]);
  });

  test('turns the highlighted partial command into one exact dispatch target', () => {
    expect(selectedCommandCompletion('/mo', commands, 0)?.name).toBe('model');
    expect(selectedCommandCompletion('/make-this-real', commands, 0)).toBeUndefined();
    expect(moveCommandCompletionSelection(0, 'previous', 3)).toBe(2);
    expect(moveCommandCompletionSelection(2, 'next', 3)).toBe(0);
    expect(resolveTuiCommandSubmission('/mo', commands, 0).type).toBe('command');
    expect(resolveTuiCommandSubmission('/mo', commands, 0, true)).toEqual({
      type: 'prompt',
      text: '/mo',
    });
  });

  test('passes a model search query into the picker outcome', async () => {
    const resolved = resolveTuiCommand('/model claude sonnet', commands);
    if (resolved.type !== 'command') throw new Error('model command was not resolved');
    expect(
      await resolved.command.execute(resolved.argumentsText, { conversationId: 'main' }),
    ).toEqual({
      type: 'dialog',
      dialog: 'model',
      query: 'claude sonnet',
    });
  });

  test('makes clear start clean and keeps old history behind explicit resume', async () => {
    const clear = resolveTuiCommand('/clear', commands);
    const resume = resolveTuiCommand('/resume', commands);
    if (clear.type !== 'command' || resume.type !== 'command') {
      throw new Error('conversation commands were not resolved');
    }
    expect(await clear.command.execute('', { conversationId: 'main' })).toEqual({
      type: 'action',
      action: 'clear-conversation',
    });
    expect(await resume.command.execute('', { conversationId: 'fresh' })).toEqual({
      type: 'dialog',
      dialog: 'sessions',
    });
  });

  test('fails closed on builtin, custom and alias collisions', () => {
    const commands = createAgentTuiBuiltinCommands();
    const duplicate = commands[0];
    if (!duplicate) throw new Error('builtin fixture is empty');
    expect(() => composeTuiCommands(commands, [duplicate])).toThrow(/collides/);
  });
});
