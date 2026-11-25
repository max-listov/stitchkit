/**
 * CommonMark fenced code blocks, for every script that reads structure out of Markdown.
 * A heading, a version or a marker inside a fence is an example, not structure.
 */
const OPEN_FENCE = /^\s{0,3}(`{3,}|~{3,})(.*)$/;
const CLOSE_FENCE = /^\s{0,3}(`{3,}|~{3,})\s*$/;

/** The fence a line stands inside: its character and the length a closing fence must reach. */
export interface FenceState {
  readonly char: string;
  readonly length: number;
}

/** Advance the fence state by one line; `isDelimiter` marks the opening or closing line itself. */
export function stepFence(
  line: string,
  fence: FenceState | null,
): { fence: FenceState | null; isDelimiter: boolean } {
  if (fence === null) {
    const open = OPEN_FENCE.exec(line);
    if (!open?.[1]) return { fence: null, isDelimiter: false };
    const char = open[1][0] ?? '';
    const info = open[2] ?? '';
    // A backtick fence cannot carry a backtick in its info string: that line is an inline code span.
    if (char === '`' && info.includes('`')) return { fence: null, isDelimiter: false };
    return { fence: { char, length: open[1].length }, isDelimiter: true };
  }
  const close = CLOSE_FENCE.exec(line);
  if (close?.[1] && close[1][0] === fence.char && close[1].length >= fence.length) {
    return { fence: null, isDelimiter: true };
  }
  return { fence, isDelimiter: false };
}

/** The lines of a document that stand outside every fenced block, delimiters excluded. */
export function linesOutsideFences(document: string): string[] {
  const lines: string[] = [];
  let fence: FenceState | null = null;
  for (const line of document.split('\n')) {
    const stepped = stepFence(line, fence);
    fence = stepped.fence;
    if (!stepped.isDelimiter && fence === null) lines.push(line);
  }
  return lines;
}
