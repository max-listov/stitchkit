/**
 * The regular-expression syntax `search_files` runs, parsed into a tree the matcher measures
 * and the linear automaton compiles. Every construct keeps JavaScript `RegExp` semantics without
 * flags, including Annex B forms and `(?ims-ims:…)` modifiers. Literals, single-unit escapes and
 * bracket classes of plain characters carry their exact unit ranges (case-folded under `i`);
 * class escapes, dot and other classes are a native one-character `RegExp` with the active
 * modifiers, so their character sets are the engine's own. Constructs whose matching needs
 * backtracking or lookaround (backreferences, lookahead, lookbehind) are reported as
 * unsupported instead of approximated.
 */
import { caseVariants } from './coding-search-case-fold';
import { classRanges } from './coding-search-class-ranges';

export type RegexAssertion = 'start' | 'end' | 'line-start' | 'line-end' | 'word' | 'not-word';

/**
 * One single-unit atom. `ranges` is the exact inclusive set when the atom is a literal or a
 * bracket class of plain characters and ranges; every other atom answers through `matches`, a
 * native one-character expression. Equal atoms are one object, so `key` identifies it.
 */
export interface UnitAtom {
  key: string;
  ranges?: readonly (readonly [number, number])[];
  matches(unit: number): boolean;
}

export type RegexNode =
  | { kind: 'empty' }
  | { kind: 'unit'; atom: UnitAtom }
  | { kind: 'assert'; at: RegexAssertion }
  | { kind: 'sequence'; items: RegexNode[] }
  | { kind: 'alternation'; options: RegexNode[] }
  | { kind: 'repeat'; body: RegexNode; min: number; max: number };

/** Thrown with the construct a host-facing refusal names. */
export class UnsupportedRegexSyntax extends Error {}

/** Counted repetition is unrolled; a larger bound is refused before it can allocate. */
export const MAX_REGEX_REPEAT = 1_000;

const QUANTIFIER = /^\{(\d+)(?:(,)(\d*))?\}/;
const MODIFIERS = /^\(\?([ims]*)(?:-([ims]*))?:/;

interface Modifiers {
  ignoreCase: boolean;
  multiline: boolean;
  dotAll: boolean;
}

const CONTROL_ESCAPES: Record<string, number> = { t: 9, n: 10, v: 11, f: 12, r: 13 };

/**
 * The one unit an escape outside a class stands for, or undefined for a class escape
 * (`\\d`, `\\w`, `\\s` and their negations), whose set only the engine enumerates.
 */
function escapedUnit(source: string): number | undefined {
  const name = source.charAt(1);
  if ('dDwWsS'.includes(name)) return undefined;
  if (name in CONTROL_ESCAPES) return CONTROL_ESCAPES[name];
  if (source.length > 2 && (name === 'x' || name === 'u'))
    return Number.parseInt(source.slice(2), 16);
  if (name === '0') return Number.parseInt(source.slice(1), 8);
  if (name === 'c') return source.charCodeAt(2) % 32;
  return source.charCodeAt(1);
}

/** Parses a pattern the native engine has already accepted without flags. */
export function parseSearchRegex(pattern: string, check: () => void): RegexNode {
  let index = 0;
  let modifiers: Modifiers = { ignoreCase: false, multiline: false, dotAll: false };
  const atoms = new Map<string, UnitAtom>();
  const unit = (key: string, create: () => Omit<UnitAtom, 'key'>): RegexNode => {
    let atom = atoms.get(key);
    if (!atom) {
      atom = { key, ...create() };
      atoms.set(key, atom);
    }
    return { kind: 'unit', atom };
  };
  const native = (source: string, ranges?: [number, number][]): RegexNode => {
    const flags = `${modifiers.ignoreCase ? 'i' : ''}${modifiers.dotAll ? 's' : ''}`;
    return unit(`${flags}/${source}`, () => {
      const expression = new RegExp(source, flags);
      return {
        ...(ranges && { ranges }),
        matches: (code: number) => expression.test(String.fromCharCode(code)),
      };
    });
  };
  const literal = (code: number): RegexNode => {
    const units = modifiers.ignoreCase ? caseVariants(code) : [code];
    return unit(`=${units.join(',')}`, () => ({
      ranges: units.map((value): [number, number] => [value, value]),
      matches: (other) => units.includes(other),
    }));
  };
  // Without a named group, `\k` is the Annex B identity escape for `k`.
  const namedGroups = /\(\?<(?![=!])/.test(pattern);

  const classEnd = (start: number): number => {
    let cursor = start + 1;
    if (pattern[cursor] === '^') cursor += 1;
    while (cursor < pattern.length && pattern[cursor] !== ']') {
      cursor += pattern[cursor] === '\\' ? 2 : 1;
    }
    return cursor + 1;
  };

  const escapeLength = (start: number): number => {
    const next = pattern[start + 1] ?? '';
    if (/[1-9]/.test(next) || (next === 'k' && namedGroups)) {
      throw new UnsupportedRegexSyntax('backreference');
    }
    if (next === '0') {
      // Legacy octal: `\0` followed by at most two more octal digits.
      const digits = /^[0-7]{0,2}/.exec(pattern.slice(start + 2))?.[0] ?? '';
      return 2 + digits.length;
    }
    if (next === 'c') return /[A-Za-z]/.test(pattern[start + 2] ?? '') ? 3 : 0;
    if (next === 'x' && /^[0-9A-Fa-f]{2}$/.test(pattern.slice(start + 2, start + 4))) return 4;
    if (next === 'u' && /^[0-9A-Fa-f]{4}$/.test(pattern.slice(start + 2, start + 6))) return 6;
    return 2;
  };

  const group = (): RegexNode => {
    if (/^\(\?(?:=|!|<=|<!)/.test(pattern.slice(index))) {
      throw new UnsupportedRegexSyntax('lookaround');
    }
    const outer = modifiers;
    const modified = MODIFIERS.exec(pattern.slice(index));
    if (modified) {
      const on = modified[1] ?? '';
      const off = modified[2] ?? '';
      const flag = (name: string, current: boolean) =>
        on.includes(name) ? true : off.includes(name) ? false : current;
      modifiers = {
        ignoreCase: flag('i', outer.ignoreCase),
        multiline: flag('m', outer.multiline),
        dotAll: flag('s', outer.dotAll),
      };
      index += modified[0].length;
    } else if (pattern.startsWith('(?<', index)) index = pattern.indexOf('>', index) + 1;
    else index += 1;
    const body = alternation();
    modifiers = outer;
    index += 1; // The native parser guarantees the closing parenthesis.
    return body;
  };

  const assertion = (character: '^' | '$'): RegexNode => {
    index += 1;
    if (character === '^')
      return { kind: 'assert', at: modifiers.multiline ? 'line-start' : 'start' };
    return { kind: 'assert', at: modifiers.multiline ? 'line-end' : 'end' };
  };

  let atomsRead = 0;
  const atom = (): RegexNode => {
    // Folding a class under `i` walks the cased units; the caller's deadline sees each batch.
    if (++atomsRead % 16 === 0) check();
    const character = pattern[index] ?? '';
    if (character === '(') return group();
    if (character === '^' || character === '$') return assertion(character);
    if (character === '\\') {
      const next = pattern[index + 1];
      if (next === 'b' || next === 'B') {
        index += 2;
        return { kind: 'assert', at: next === 'b' ? 'word' : 'not-word' };
      }
      const length = escapeLength(index);
      if (length === 0) {
        // Annex B: `\c` without a control letter is a literal backslash; `c` follows.
        index += 1;
        return literal(0x5c);
      }
      const source = pattern.slice(index, index + length);
      index += length;
      const code = escapedUnit(source);
      // The decoded unit is confirmed by the engine itself before it becomes a range.
      if (code !== undefined && new RegExp(`^${source}$`).test(String.fromCharCode(code))) {
        return literal(code);
      }
      // A class escape (`\\d`, `\\w`, `\\s`, negations) is the class holding it alone.
      return native(source, classRanges(`[${source}]`, modifiers.ignoreCase));
    }
    if (character === '[') {
      const end = classEnd(index);
      const source = pattern.slice(index, end);
      index = end;
      return native(source, classRanges(source, modifiers.ignoreCase));
    }
    index += 1;
    if (character === '.') {
      return native(
        '.',
        classRanges(modifiers.dotAll ? '[\\s\\S]' : '[^\\n\\r\\u2028\\u2029]'),
      );
    }
    return literal(character.charCodeAt(0));
  };

  const quantified = (body: RegexNode): RegexNode => {
    const character = pattern[index];
    let min: number;
    let max: number;
    if (character === '*' || character === '+' || character === '?') {
      min = character === '+' ? 1 : 0;
      max = character === '?' ? 1 : Number.POSITIVE_INFINITY;
      index += 1;
    } else {
      const counted = character === '{' ? QUANTIFIER.exec(pattern.slice(index)) : null;
      if (!counted) return body;
      min = Number(counted[1]);
      max =
        counted[2] === undefined
          ? min
          : counted[3]
            ? Number(counted[3])
            : Number.POSITIVE_INFINITY;
      if (min > MAX_REGEX_REPEAT || (Number.isFinite(max) && max > MAX_REGEX_REPEAT)) {
        throw new UnsupportedRegexSyntax(`repetition beyond ${MAX_REGEX_REPEAT}`);
      }
      index += counted[0].length;
    }
    // Laziness changes which match is reported, never whether one exists.
    if (pattern[index] === '?') index += 1;
    return { kind: 'repeat', body, min, max };
  };

  const sequence = (): RegexNode => {
    const items: RegexNode[] = [];
    while (index < pattern.length && pattern[index] !== '|' && pattern[index] !== ')') {
      items.push(quantified(atom()));
    }
    if (items.length === 0) return { kind: 'empty' };
    return items.length === 1 && items[0] ? items[0] : { kind: 'sequence', items };
  };

  function alternation(): RegexNode {
    const options = [sequence()];
    while (pattern[index] === '|') {
      index += 1;
      options.push(sequence());
    }
    return options.length === 1 && options[0] ? options[0] : { kind: 'alternation', options };
  }

  return alternation();
}
