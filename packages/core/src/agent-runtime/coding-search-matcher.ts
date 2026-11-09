import { buildAutomaton, lazyMatcher, type SearchRegex } from './coding-search-automaton';
import {
  parseSearchRegex,
  type RegexNode,
  UnsupportedRegexSyntax,
} from './coding-search-regex-syntax';
import { codingRefusal } from './coding-tool-refusals';

/**
 * Backtracking steps one native match of one line may spend. The engine itself stops after
 * 100,000,000 counted operations per call and then answers no match, and one step of this model
 * costs it about two; 2^24 keeps a threefold margin below that limit, so a native line never ends
 * in a silent false. Native matching cannot be interrupted, so this also bounds the deadline's
 * overshoot to one such line.
 */
export const MAX_NATIVE_LINE_WORK = 2 ** 24;
/** Lines are searched up to 8,192 UTF-8 bytes, so never more UTF-16 units than that. */
const LONGEST_LINE = 8_192;

/** Whether every option is one unit atom with known ranges and no unit is accepted twice. */
function disjointUnits(options: RegexNode[]): boolean {
  const ranges: (readonly [number, number])[] = [];
  for (const option of options) {
    if (option.kind !== 'unit' || !option.atom.ranges) return false;
    ranges.push(...option.atom.ranges);
  }
  ranges.sort((left, right) => left[0] - right[0]);
  return ranges.every(
    (range, index) => index === 0 || range[0] > (ranges[index - 1]?.[1] ?? -1),
  );
}

/** Whether a node can match without consuming a unit. */
function matchesEmpty(node: RegexNode): boolean {
  switch (node.kind) {
    case 'empty':
    case 'assert':
      return true;
    case 'unit':
      return false;
    case 'repeat':
      return node.min === 0 || matchesEmpty(node.body);
    case 'sequence':
      return node.items.every(matchesEmpty);
    case 'alternation':
      return node.options.some(matchesEmpty);
  }
}

/**
 * The backtracking work per start position of a line of at most `units` units: each start
 * walks each path through the alternatives once, so paths × the longest path bounds it. On such
 * a line no repetition iterates more than `units` times beyond the iterations it requires (and
 * a body that cannot match empty cannot even reach those), so `x{m,M}`, `x*` and `x+` are their
 * unrolled forms with the bounds capped there: p^m × (1 + p + … + p^(M−m)) paths and M × the
 * body's length.
 */
export function backtrackingWork(
  node: RegexNode,
  units: number,
): { paths: number; length: number } {
  switch (node.kind) {
    case 'empty':
      return { paths: 1, length: 0 };
    case 'unit':
    case 'assert':
      return { paths: 1, length: 1 };
    case 'repeat': {
      const body = backtrackingWork(node.body, units);
      // The required iterations run even when the body matches empty; past them an empty
      // iteration ends the loop, so each further one consumes a unit of the line.
      const empty = matchesEmpty(node.body);
      const min = empty ? node.min : Math.min(node.min, units);
      const max = Math.min(node.max, empty ? node.min + units : units);
      let paths = 1;
      let optional = 1;
      for (
        let count = 0;
        count < max && paths * optional <= MAX_NATIVE_LINE_WORK;
        count += 1
      ) {
        if (count < min) paths *= body.paths;
        else optional = 1 + body.paths * optional;
      }
      // An iteration that consumes nothing is still a step: a body of length 0 repeated a
      // million times is a million steps.
      return { paths: paths * optional, length: max * Math.max(body.length, 1) };
    }
    case 'sequence':
      return node.items.reduce(
        (total, item) => {
          const part = backtrackingWork(item, units);
          return { paths: total.paths * part.paths, length: total.length + part.length };
        },
        { paths: 1, length: 0 },
      );
    case 'alternation':
      // Alternatives that are single units no two of which accept the same unit leave one way
      // forward at each position; the rest fail at their first step, like members of a class.
      if (disjointUnits(node.options)) return { paths: 1, length: node.options.length };
      return node.options.reduce(
        (total, option) => {
          const part = backtrackingWork(option, units);
          return {
            paths: total.paths + part.paths,
            length: Math.max(total.length, part.length),
          };
        },
        { paths: 0, length: 0 },
      );
  }
}

/**
 * The groups of a pattern. On each step the engine may enter, leave and save the state of every
 * group the step lies in — all enclosing groups and, inside a repeated body, every group of that
 * body — so a step costs up to this many group operations more. The count bounds both nesting
 * depth and the width of a repeated body.
 */
function groupCount(pattern: string): number {
  let groups = 0;
  let inClass = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '\\') index += 1;
    else if (inClass) inClass = character !== ']';
    else if (character === '[') inClass = true;
    else if (character === '(') groups += 1;
  }
  return groups;
}

function validated(pattern: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch (error) {
    codingRefusal('BAD_REQUEST', 'This pattern is not a valid regular expression', {
      details: { pattern, reason: error instanceof Error ? error.message : String(error) },
      hint: 'Fix the expression, or use regex: false.',
      cause: error,
    });
  }
}

function refuseUnsupported(error: unknown): never {
  if (!(error instanceof UnsupportedRegexSyntax)) throw error;
  codingRefusal('BAD_REQUEST', `Search regex cannot use ${error.message}`, {
    hint: 'Groups, alternation, classes, modifiers and quantifiers are supported; backreferences and lookaround are not. Rewrite the pattern or use regex: false.',
    cause: error,
  });
}

/** The linear automaton alone, for any accepted pattern. */
export function compileLinearSearchRegex(pattern: string, check: () => void): SearchRegex {
  validated(pattern);
  try {
    return lazyMatcher(buildAutomaton(parseSearchRegex(pattern, check), check), check);
  } catch (error) {
    refuseUnsupported(error);
  }
}

/**
 * JavaScript `RegExp` syntax without flags with bounded cost per line. A line whose bounded
 * backtracking work — per start position × its length, repetition capped at its length — stays
 * within `MAX_NATIVE_LINE_WORK` runs on the native engine itself; the deadline is observed
 * between lines. Any other line runs on the linear automaton, because a deadline cannot
 * interrupt one native match. The work is measured per power-of-two line length, once.
 */
export function compileSearchRegex(pattern: string, check: () => void): SearchRegex {
  const expression = validated(pattern);
  try {
    const tree = parseSearchRegex(pattern, check);
    const nativeUpTo = new Map<number, boolean>();
    const groups = groupCount(pattern);
    const native = (length: number) => {
      let bucket = 16;
      while (bucket < length) bucket *= 2;
      let found = nativeUpTo.get(bucket);
      if (found === undefined) {
        const work = backtrackingWork(tree, bucket);
        found =
          work.paths * Math.max(work.length, 1) * bucket * (groups + 1) <=
          MAX_NATIVE_LINE_WORK;
        nativeUpTo.set(bucket, found);
      }
      return found;
    };
    // The automaton is built, and its refusals raised, before any file is read, unless no
    // searchable line can need it; a longer text from a direct caller builds it then.
    let automaton = native(LONGEST_LINE)
      ? undefined
      : lazyMatcher(buildAutomaton(tree, check), check);
    return {
      test(text) {
        if (native(text.length)) {
          check();
          return expression.test(text);
        }
        automaton ??= lazyMatcher(buildAutomaton(tree, check), check);
        return automaton.test(text);
      },
    };
  } catch (error) {
    refuseUnsupported(error);
  }
}
