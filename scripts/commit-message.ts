/**
 * Commit-message hygiene.
 *
 * A shell-quoting slip once put the two characters `\` `n` into a pushed
 * commit body instead of a paragraph break, and history keeps it forever. The
 * check is deliberately narrow: only escape sequences that a human never types
 * on purpose in prose, and only outside code fences/backticks where `\n` is
 * legitimately being discussed.
 */
import { type FenceState, stepFence } from './markdown-fences';

const ESCAPES = /(?<!\\)\\[nrt]/;

/** Comment lines git itself strips, plus the scissors section of a verbose commit. */
function meaningfulLines(message: string): string[] {
  const lines: string[] = [];
  for (const line of message.split(/\r?\n/)) {
    if (line.startsWith('#')) continue;
    if (line.startsWith('diff --git ')) break;
    lines.push(line);
  }
  return lines;
}

/**
 * Line indices covered by properly closed fenced blocks.
 * An unterminated opening fence never closes, so its lines are not marked and
 * cannot swallow a real escape slip later in the commit message.
 */
function balancedFencedLineIndices(lines: readonly string[]): Set<number> {
  const fenced = new Set<number>();
  let fence: FenceState | null = null;
  let openIndex = -1;
  for (const [index, line] of lines.entries()) {
    const stepped = stepFence(line, fence);
    if (fence === null && stepped.fence !== null) {
      openIndex = index;
    } else if (fence !== null && stepped.fence === null) {
      for (let lineIndex = openIndex; lineIndex <= index; lineIndex += 1) {
        fenced.add(lineIndex);
      }
      openIndex = -1;
    }
    fence = stepped.fence;
  }
  return fenced;
}

export function findLiteralEscapes(message: string): string[] {
  const lines = meaningfulLines(message);
  const fenced = balancedFencedLineIndices(lines);
  const offenders: string[] = [];
  for (const [index, line] of lines.entries()) {
    if (fenced.has(index)) continue;
    // A backticked span is quoting the sequence, not producing it.
    const prose = line.replace(/`[^`]*`/g, '');
    if (ESCAPES.test(prose)) offenders.push(`line ${index + 1}: ${line.trim()}`);
  }
  return offenders;
}

export function assertCommitMessage(message: string): void {
  const offenders = findLiteralEscapes(message);
  if (offenders.length === 0) return;
  throw new Error(
    `commit message contains literal escape sequences instead of real line breaks:\n  ${offenders.join(
      '\n  ',
    )}\nWrite the body with actual newlines (git commit -F - or repeated -m).`,
  );
}

if (import.meta.main) {
  const [path] = Bun.argv.slice(2);
  if (!path) throw new Error('Usage: commit-message.ts <path-to-COMMIT_EDITMSG>');
  assertCommitMessage(await Bun.file(path).text());
}
