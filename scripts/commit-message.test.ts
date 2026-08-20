import { describe, expect, test } from 'bun:test';
import { assertCommitMessage, findLiteralEscapes } from './commit-message';

describe('commit message hygiene', () => {
  test('rejects a body whose paragraph break arrived as the two characters backslash-n', () => {
    // The exact 0.55.0 slip: one pushed line instead of two paragraphs.
    const message =
      'test(server): align shutdown timing with force budget\n\n' +
      'Separate the graceful deadline assertion.\\n\\nKeep the test bounded.';
    expect(findLiteralEscapes(message)).toHaveLength(1);
    expect(() => assertCommitMessage(message)).toThrow('literal escape sequences');
  });

  test('accepts a body written with real newlines', () => {
    const message =
      'fix(server): drain sockets before stop\n\nThe close handshake finishes first.\n\nThen the listener stops.';
    expect(findLiteralEscapes(message)).toEqual([]);
    expect(() => assertCommitMessage(message)).not.toThrow();
  });

  test('a quoted or fenced escape is documentation, not a slip', () => {
    const backticked =
      'docs(cli): explain the separator\n\nThe parser splits on `\\n` per line.';
    const fenced = ['feat(cli): add ndjson output', '', '```ts', "join('\\n')", '```'].join(
      '\n',
    );
    expect(findLiteralEscapes(backticked)).toEqual([]);
    expect(findLiteralEscapes(fenced)).toEqual([]);
  });

  test('an unterminated fence does not swallow a real slip after it', () => {
    const message = ['chore: tidy', '', '```ts', "join('x')", '', 'Body broke.\\nHere.'].join(
      '\n',
    );
    expect(findLiteralEscapes(message)).toHaveLength(1);
  });

  test('an intentionally escaped backslash-n is not a slip', () => {
    const message = 'docs: explain escaping\n\nWrite \\\\n when the output must contain it.';
    expect(findLiteralEscapes(message)).toEqual([]);
  });

  test('git comment lines and the verbose diff are not part of the message', () => {
    const message = [
      'chore: tidy',
      '',
      '# Please enter the commit message. Lines starting with \\n are ignored.',
      'diff --git a/x b/x',
      '+const line = "a\\nb";',
    ].join('\n');
    expect(findLiteralEscapes(message)).toEqual([]);
  });
});
