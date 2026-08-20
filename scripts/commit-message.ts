/**
 * Commit-message hygiene.
 *
 * A shell-quoting slip once put the two characters `\` `n` into a pushed
 * commit body instead of a paragraph break, and history keeps it forever. The
 * check is deliberately narrow: only escape sequences that a human never types
 * on purpose in prose, and only outside code fences/backticks where `\n` is
 * legitimately being discussed.
 */
const ESCAPES = /(?<!\\)\\[nrt]/;

/** Comment lines git itself strips, plus the scissors section of a verbose commit. */
function meaningfulLines(message: string): string[] {
  const lines: string[] = [];
  for (const line of message.split('\n')) {
    if (line.startsWith('#')) continue;
    if (line.startsWith('diff --git ')) break;
    lines.push(line);
  }
  return lines;
}

export function findLiteralEscapes(message: string): string[] {
  const lines = meaningfulLines(message);
  // An UNTERMINATED fence must not swallow the rest of the body — an opening
  // fence with no closing one is a typo, not an exemption.
  const fenceCount = lines.filter((line) => line.trimStart().startsWith('```')).length;
  const fencesBalanced = fenceCount % 2 === 0;
  const offenders: string[] = [];
  let fenced = false;
  for (const [index, line] of lines.entries()) {
    if (fencesBalanced && line.trimStart().startsWith('```')) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
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
