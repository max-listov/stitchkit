import { expect, test } from 'bun:test';
import { compileWorkspaceGlob } from '../src/agent-runtime/workspace-glob';

/** The established public grammar, kept as an independent differential oracle. */
function establishedGlob(pattern: string): RegExp {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        if (pattern[index + 2] === '/') {
          source += '(?:[^/]+/)*';
          index += 2;
          continue;
        }
        source += '.*';
        index += 1;
        continue;
      }
      source += '[^/]*';
      continue;
    }
    if (character === '?') {
      source += '[^/]';
      continue;
    }
    source += character?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') ?? '';
  }
  return new RegExp(`^${source}$`);
}

test('workspace glob preserves the established grammar and never prunes a matching descendant', () => {
  const atoms = ['a', '/', '*', '**', '**/', '?', '.', '[x]', '\n', '😀'];
  const patterns = ['', '**/docs/**', 'ab**cd', 'a**/b', '***'];
  for (const left of atoms)
    for (const middle of atoms)
      for (const right of atoms) patterns.push(left + middle + right);
  const paths = [
    '',
    'a',
    'b',
    'ab',
    'ax/b',
    'a/b',
    'a//b',
    'ab/cd',
    'a/b/c',
    'docs/m.md',
    'x/docs/m.md',
    '[x]',
    '.',
    '😀',
    '\n',
    '\r',
    '\u2028',
    '\u2029',
  ];
  for (const left of ['a', 'b', '\n', '\r', '\u2028', '😀'])
    for (const right of ['a', 'b', '.', '\n', '😀']) paths.push(`${left}/${right}`);
  for (const pattern of patterns) {
    const oracle = establishedGlob(pattern);
    const compiled = compileWorkspaceGlob(pattern);
    for (const candidate of paths) {
      const matches = oracle.test(candidate);
      expect({ pattern, candidate, matches: compiled.test(candidate) }).toEqual({
        pattern,
        candidate,
        matches,
      });
      if (matches) {
        for (
          let index = candidate.indexOf('/');
          index >= 0;
          index = candidate.indexOf('/', index + 1)
        ) {
          if (candidate.charAt(index + 1) !== '/' && candidate.length > index + 1)
            expect(compiled.mayContain(candidate.slice(0, index))).toBe(true);
        }
      }
    }
  }
  expect(compileWorkspaceGlob('docs/**').mayContain('unrelated')).toBe(false);
  expect(compileWorkspaceGlob('*.ts').mayContain('src')).toBe(false);
  expect(compileWorkspaceGlob('**/docs/**').mayContain('unrelated')).toBe(true);
});

test('workspace glob repetition has a finite state bound instead of recursive backtracking', () => {
  const compiled = compileWorkspaceGlob(`${'**a'.repeat(80)}b`);
  expect(compiled.test('a'.repeat(500))).toBe(false);
  expect(compiled.test(`${'a'.repeat(80)}b`)).toBe(true);
});
