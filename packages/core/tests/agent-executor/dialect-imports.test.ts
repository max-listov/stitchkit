/** A dialect's entrypoint carries only its own engine: Codex and ACP never load the Claude transcript reader. */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const SRC = resolve(import.meta.dir, '../../src');

/** Every source file `entry` reaches through relative imports. */
function reachedFrom(entry: string): Set<string> {
  const visited = new Set<string>();
  const queue = [resolve(SRC, entry)];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (visited.has(file)) continue;
    visited.add(file);
    for (const match of readFileSync(file, 'utf8').matchAll(
      /(?:from\s+|import\s*\(\s*|^import\s+)'(\.{1,2}\/[^']+)'/gm,
    )) {
      const spec = match[1];
      if (spec === undefined) continue;
      const base = resolve(dirname(file), spec);
      const candidate = base.endsWith('.ts') ? base : `${base}.ts`;
      if (candidate.startsWith(SRC)) queue.push(candidate);
    }
  }
  return visited;
}

test.each(['entrypoints/agent-executor/codex.ts', 'entrypoints/agent-executor/acp.ts'])(
  '%s does not reach claude/transcript.ts',
  (entry) => {
    const reached = reachedFrom(entry);
    expect(reached.size).toBeGreaterThan(5);
    expect(reached.has(resolve(SRC, 'agent-executor/claude/transcript.ts'))).toBe(false);
  },
);

test('the walk does find claude/transcript.ts from the Claude CLI entrypoint (positive control)', () => {
  expect(
    reachedFrom('entrypoints/agent-executor/claude.ts').has(
      resolve(SRC, 'agent-executor/claude/transcript.ts'),
    ),
  ).toBe(true);
});
