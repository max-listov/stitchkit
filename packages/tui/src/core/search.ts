export interface TerminalSearchOptions {
  /**
   * Accept a word whose letters appear in order but apart (`cst` in
   * `queue_state`). On by default for pickers; off for command completion,
   * where only a contiguous match is a useful suggestion.
   */
  scattered?: boolean;
}

/** A match of a query in a text: its quality and the code-point ranges to highlight. */
export interface TerminalSearchMatch {
  /** Higher is better; only meaningful between matches of one query. */
  score: number;
  /** `[start, end)` code-point ranges of the text that matched, ascending and disjoint. */
  ranges: [number, number][];
}

/** One lower-cased unit per code point of the text, so a match index is a code-point index of the original. */
function fold(text: string): string[] {
  return Array.from(text, (char) => char.toLocaleLowerCase());
}

/** The first unit index where `needle` occurs in `haystack`, or -1. */
function indexOfUnits(haystack: readonly string[], needle: readonly string[]): number {
  outer: for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) continue outer;
    }
    return start;
  }
  return -1;
}

function rangesOf(positions: readonly number[]): [number, number][] {
  const ranges: [number, number][] = [];
  for (const position of positions) {
    const last = ranges.at(-1);
    if (last && last[1] === position) last[1] += 1;
    else ranges.push([position, position + 1]);
  }
  return ranges;
}

/**
 * Match `query` against `text` the way a picker should: every query word must
 * appear, as a substring or failing that as an in-order subsequence; substrings
 * beat scattered letters, word starts beat word middles, earlier beats later.
 * An empty query matches everything with no highlight. Case-insensitive.
 */
export function matchTerminalSearch(
  query: string,
  text: string,
  options: TerminalSearchOptions = {},
): TerminalSearchMatch | null {
  const words = query.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return { score: 0, ranges: [] };
  const haystack = fold(text);
  const isBoundary = (index: number): boolean =>
    index === 0 || /[\s\-_./:·,(]/.test(haystack[index - 1] ?? ' ');
  let score = 0;
  const positions = new Set<number>();
  for (const word of words) {
    const needle = fold(word);
    const start = indexOfUnits(haystack, needle);
    if (start >= 0) {
      for (let offset = 0; offset < needle.length; offset += 1) positions.add(start + offset);
      score += 100 + (isBoundary(start) ? 50 : 0) - Math.min(start, 40);
      continue;
    }
    if (options.scattered === false) return null;
    let cursor = 0;
    let gaps = 0;
    const found: number[] = [];
    for (const letter of needle) {
      let index = cursor;
      while (index < haystack.length && haystack[index] !== letter) index += 1;
      if (index >= haystack.length) return null;
      if (found.length > 0) gaps += index - cursor;
      found.push(index);
      cursor = index + 1;
    }
    for (const index of found) positions.add(index);
    score += 20 + found.filter(isBoundary).length * 5 - Math.min(gaps, 30);
  }
  return { score, ranges: rangesOf([...positions].sort((a, b) => a - b)) };
}

/**
 * Items that match, best first; equal scores keep the input order, so a list a
 * reader knows does not reshuffle while they type.
 */
export function searchTerminalItems<ITEM>(
  items: readonly ITEM[],
  query: string,
  text: (item: ITEM) => string,
  options: TerminalSearchOptions = {},
): { item: ITEM; match: TerminalSearchMatch }[] {
  const results: { item: ITEM; match: TerminalSearchMatch; index: number }[] = [];
  items.forEach((item, index) => {
    const match = matchTerminalSearch(query, text(item), options);
    if (match) results.push({ item, match, index });
  });
  if (query.trim() !== '') {
    results.sort((a, b) => b.match.score - a.match.score || a.index - b.index);
  }
  return results.map(({ item, match }) => ({ item, match }));
}

/** Split `text` into plain and highlighted runs for a match's ranges. */
export function terminalHighlightRuns(
  text: string,
  ranges: readonly [number, number][],
): { text: string; highlighted: boolean }[] {
  const points = Array.from(text);
  const runs: { text: string; highlighted: boolean }[] = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start > cursor)
      runs.push({ text: points.slice(cursor, start).join(''), highlighted: false });
    runs.push({ text: points.slice(start, end).join(''), highlighted: true });
    cursor = end;
  }
  if (cursor < points.length)
    runs.push({ text: points.slice(cursor).join(''), highlighted: false });
  return runs;
}
