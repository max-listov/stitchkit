import { type UnitAtom, UnsupportedRegexSyntax } from './coding-search-regex-syntax';

/** What a position's assertions can observe about a neighbouring unit. */
export const Ahead = { End: 0, Word: 1, LineTerminator: 2, Other: 3 } satisfies Record<
  string,
  number
>;
export type Ahead = (typeof Ahead)[keyof typeof Ahead];

const isWord = (unit: number) =>
  (unit >= 48 && unit <= 57) ||
  (unit >= 65 && unit <= 90) ||
  (unit >= 97 && unit <= 122) ||
  unit === 95;
const isLineTerminator = (unit: number) =>
  unit === 10 || unit === 13 || unit === 0x2028 || unit === 0x2029;
export const classify = (unit: number): Ahead =>
  isWord(unit) ? Ahead.Word : isLineTerminator(unit) ? Ahead.LineTerminator : Ahead.Other;

/** Atom memberships the range partition may hold, summed over its segments. */
export const MAX_RANGE_MEMBERSHIPS = 1 << 22;
/**
 * Atoms the engine must answer per unit: only classes whose ranges the engine check sent back,
 * since literals, escapes, classes and dot all carry ranges. Their work is this × 65,536 units.
 */
export const MAX_NATIVE_ATOMS = 64;
const UNITS = 0x1_0000;

interface UnitClass {
  kind: Ahead;
  /** Sorted range-atom indices containing the class's units. */
  ranged: Int32Array;
  /** One bit per native atom answering yes. */
  native: Uint32Array;
  /** Every atom accepting the class's units, built on first use. */
  atoms?: UnitAtom[];
}

function contains(sorted: Int32Array, value: number): boolean {
  let low = 0;
  let high = sorted.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const found = sorted[middle] ?? 0;
    if (found === value) return true;
    if (found < value) low = middle + 1;
    else high = middle - 1;
  }
  return false;
}

/**
 * Splits the UTF-16 alphabet into the segments no range atom tells apart, by one sort of all
 * range endpoints: a pattern of thousands of literals or plain classes costs its endpoints,
 * never atoms × units. Overlap is bounded by `MAX_RANGE_MEMBERSHIPS` and refused past it.
 */
function partition(ranged: UnitAtom[], check: () => void) {
  const boundaries = new Set([0, UNITS]);
  for (const atom of ranged) {
    for (const [low, high] of atom.ranges ?? []) {
      boundaries.add(low);
      boundaries.add(high + 1);
    }
  }
  const points = [...boundaries].sort((left, right) => left - right);
  const segmentOf = new Int32Array(UNITS);
  const starts = new Map<number, number[]>();
  const ends = new Map<number, number[]>();
  for (const [index, atom] of ranged.entries()) {
    for (const [low, high] of atom.ranges ?? []) {
      const opening = starts.get(low) ?? [];
      opening.push(index);
      starts.set(low, opening);
      const closing = ends.get(high + 1) ?? [];
      closing.push(index);
      ends.set(high + 1, closing);
    }
  }
  const active = new Set<number>();
  const members: Int32Array[] = [];
  let memberships = 0;
  for (let segment = 0; segment + 1 < points.length; segment += 1) {
    const from = points[segment] ?? 0;
    const to = points[segment + 1] ?? UNITS;
    for (const index of ends.get(from) ?? []) active.delete(index);
    for (const index of starts.get(from) ?? []) active.add(index);
    memberships += active.size;
    if (memberships > MAX_RANGE_MEMBERSHIPS) {
      throw new UnsupportedRegexSyntax('character sets that overlap too much');
    }
    if (segment % 128 === 0) check();
    members.push(Int32Array.from(active).sort());
    segmentOf.fill(segment, from, to);
  }
  return { segmentOf, members };
}

/**
 * UTF-16 units the automaton cannot tell apart share one class: the same range segment, the
 * same answers from every native atom and the same kind for word and line assertions.
 * Transitions are keyed by class, so a text over a large alphabet caches as few transitions as
 * the pattern distinguishes. Classes are at most the 65,536 units, each with a fixed-size bit
 * set over the native atoms, so the table needs no eviction.
 */
export function unitClasses(atoms: UnitAtom[], check: () => void) {
  const ranged: UnitAtom[] = [];
  const natives: UnitAtom[] = [];
  const indexOf = new Map<UnitAtom, { ranged: boolean; index: number }>();
  for (const atom of atoms) {
    if (indexOf.has(atom)) continue;
    const list = atom.ranges ? ranged : natives;
    indexOf.set(atom, { ranged: list === ranged, index: list.push(atom) - 1 });
  }
  if (natives.length > MAX_NATIVE_ATOMS) {
    throw new UnsupportedRegexSyntax(
      `more than ${MAX_NATIVE_ATOMS} character classes the engine must evaluate unit by unit`,
    );
  }
  const { segmentOf, members } = partition(ranged, check);
  const words = Math.ceil(natives.length / 32);
  const classOfUnit = new Int32Array(UNITS).fill(-1);
  const known = new Map<string, number>();
  const classes: UnitClass[] = [];
  let evaluations = 0;
  const classOf = (unit: number): number => {
    const cached = classOfUnit[unit] ?? -1;
    if (cached >= 0) return cached;
    const kind = classify(unit);
    const segment = segmentOf[unit] ?? 0;
    const native = new Uint32Array(words);
    for (const [index, atom] of natives.entries()) {
      if (++evaluations % 128 === 0) check();
      if (atom.matches(unit))
        native[index >> 5] = (native[index >> 5] ?? 0) | (1 << (index & 31));
    }
    const key = `${kind}:${segment}:${native.join(',')}`;
    let found = known.get(key);
    if (found === undefined) {
      found = classes.push({ kind, ranged: members[segment] ?? new Int32Array(), native }) - 1;
      known.set(key, found);
    }
    classOfUnit[unit] = found;
    return found;
  };
  const nativeBit = (found: UnitClass, index: number) =>
    ((found.native[index >> 5] ?? 0) & (1 << (index & 31))) !== 0;
  return {
    classOf,
    kindOf: (unitClass: number): Ahead => classes[unitClass]?.kind ?? Ahead.Other,
    atomsOf: (unitClass: number): readonly UnitAtom[] => {
      const found = classes[unitClass];
      if (!found) return [];
      found.atoms ??= [
        ...Array.from(found.ranged, (index) => ranged[index]),
        ...natives.filter((_, index) => nativeBit(found, index)),
      ].filter((atom) => atom !== undefined);
      return found.atoms;
    },
    matches: (atom: UnitAtom, unitClass: number): boolean => {
      const place = indexOf.get(atom);
      const found = classes[unitClass];
      if (!place || !found) return false;
      return place.ranged
        ? contains(found.ranged, place.index)
        : nativeBit(found, place.index);
    },
  };
}
