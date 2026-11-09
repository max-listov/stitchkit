import { casedUnits, caseVariants } from './coding-search-case-fold';

/**
 * Exact unit ranges of a bracket class without the `u` flag, including escapes inside it, so
 * the automaton partitions the alphabet instead of asking the engine per unit. Every result is
 * checked against the engine at each range boundary and midpoint; any doubt leaves the class to
 * the engine.
 */
export type UnitRanges = [number, number][];

const MAX_UNIT = 0xffff;
const CONTROL_ESCAPES: Record<string, number> = { b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };

let classEscapes: Map<string, UnitRanges> | undefined;

/** `\d`, `\w`, `\s` and their negations, read from the engine once over every unit. */
function classEscape(name: string): UnitRanges {
  if (!classEscapes) {
    classEscapes = new Map();
    for (const letter of ['d', 'D', 'w', 'W', 's', 'S']) {
      const expression = new RegExp(`\\${letter}`);
      const ranges: UnitRanges = [];
      for (let unit = 0; unit <= MAX_UNIT; unit += 1) {
        if (!expression.test(String.fromCharCode(unit))) continue;
        const last = ranges.at(-1);
        if (last && last[1] === unit - 1) last[1] = unit;
        else ranges.push([unit, unit]);
      }
      classEscapes.set(letter, ranges);
    }
  }
  return classEscapes.get(name) ?? [];
}

function merge(ranges: UnitRanges): UnitRanges {
  const sorted = [...ranges].sort((left, right) => left[0] - right[0]);
  const merged: UnitRanges = [];
  for (const [low, high] of sorted) {
    const last = merged.at(-1);
    if (last && low <= last[1] + 1) last[1] = Math.max(last[1], high);
    else merged.push([low, high]);
  }
  return merged;
}

function complement(ranges: UnitRanges): UnitRanges {
  const result: UnitRanges = [];
  let next = 0;
  for (const [low, high] of ranges) {
    if (low > next) result.push([next, low - 1]);
    next = high + 1;
  }
  if (next <= MAX_UNIT) result.push([next, MAX_UNIT]);
  return result;
}

/** One class item: a single unit, a set (class escape) or undefined when unsure. */
function classItem(
  body: string,
  start: number,
): { unit?: number; set?: UnitRanges; length: number } | undefined {
  if (body[start] !== '\\') return { unit: body.charCodeAt(start), length: 1 };
  const name = body.charAt(start + 1);
  if ('dDwWsS'.includes(name)) return { set: classEscape(name), length: 2 };
  if (name in CONTROL_ESCAPES) return { unit: CONTROL_ESCAPES[name], length: 2 };
  const hex = (digits: number) => body.slice(start + 2, start + 2 + digits);
  if (name === 'x' && /^[0-9A-Fa-f]{2}$/.test(hex(2)))
    return { unit: Number.parseInt(hex(2), 16), length: 4 };
  if (name === 'u' && /^[0-9A-Fa-f]{4}$/.test(hex(4)))
    return { unit: Number.parseInt(hex(4), 16), length: 6 };
  if (name === 'c') {
    // Annex B also accepts a digit or underscore as the control letter inside a class.
    const letter = body.charAt(start + 2);
    // Otherwise (Annex B) the backslash is itself a member and `c` is read as the next item.
    return /[A-Za-z0-9_]/.test(letter)
      ? { unit: letter.charCodeAt(0) % 32, length: 3 }
      : { unit: 0x5c, length: 1 };
  }
  if (/[0-7]/.test(name)) {
    // Legacy octal: ZeroToThree takes two more octal digits, FourToSeven one.
    const digits =
      /^[0-7]+/.exec(body.slice(start + 1, start + (name <= '3' ? 4 : 3)))?.[0] ?? name;
    return { unit: Number.parseInt(digits, 8), length: 1 + digits.length };
  }
  if (name === '') return undefined;
  return { unit: body.charCodeAt(start + 1), length: 2 };
}

function parsed(source: string): { positive: UnitRanges; negated: boolean } | undefined {
  let body = source.slice(1, -1);
  const negated = body.startsWith('^');
  if (negated) body = body.slice(1);
  const ranges: UnitRanges = [];
  const add = (item: { unit?: number; set?: UnitRanges }) => {
    if (item.set) ranges.push(...item.set);
    else if (item.unit !== undefined) ranges.push([item.unit, item.unit]);
  };
  for (let index = 0; index < body.length; ) {
    const first = classItem(body, index);
    if (!first) return undefined;
    index += first.length;
    if (body[index] !== '-' || index + 1 >= body.length) {
      add(first);
      continue;
    }
    // `atom - atom` is consumed as one unit of the grammar either way: a range between two
    // units, or (Annex B) the union of both and the hyphen when either is a class escape.
    const second = classItem(body, index + 1);
    if (!second) return undefined;
    index += 1 + second.length;
    if (first.unit !== undefined && second.unit !== undefined) {
      ranges.push([first.unit, second.unit]);
      continue;
    }
    add(first);
    add({ unit: 0x2d });
    add(second);
  }
  return { positive: merge(ranges), negated };
}

/**
 * The positive set under `i`: a unit belongs when some member shares its canonical form. Only
 * units that have another case form can join, so the work is the cased units, not the set.
 */
function caseFolded(positive: UnitRanges): UnitRanges {
  const inside = (unit: number) => contains(positive, unit);
  const added: UnitRanges = [];
  for (const unit of casedUnits()) {
    if (!inside(unit) && caseVariants(unit).some(inside)) added.push([unit, unit]);
  }
  return added.length > 0 ? merge([...positive, ...added]) : positive;
}

function contains(ranges: UnitRanges, unit: number): boolean {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const range = ranges[middle];
    if (!range) return false;
    if (unit < range[0]) high = middle - 1;
    else if (unit > range[1]) low = middle + 1;
    else return true;
  }
  return false;
}

/** The exact ranges of a bracket class, or undefined when only the engine can answer. */
export function classRanges(source: string, ignoreCase = false): UnitRanges | undefined {
  const found = parsed(source);
  if (!found) return undefined;
  // Under `i` the class folds its members first; negation applies to the folded set.
  const positive = ignoreCase ? caseFolded(found.positive) : found.positive;
  const ranges = found.negated ? complement(positive) : positive;
  const expression = new RegExp(source, ignoreCase ? 'i' : '');
  const inside = (unit: number) => contains(ranges, unit);
  for (const [low, high] of ranges.length > 0
    ? ranges
    : [[0, MAX_UNIT] satisfies [number, number]]) {
    for (const unit of [low - 1, low, (low + high) >> 1, high, high + 1]) {
      if (unit < 0 || unit > MAX_UNIT) continue;
      if (expression.test(String.fromCharCode(unit)) !== inside(unit)) return undefined;
    }
  }
  return ranges;
}
