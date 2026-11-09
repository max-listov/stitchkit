import { expect, test } from 'bun:test';
import { classRanges } from '../src/agent-runtime/coding-search-class-ranges';

const WRITTEN = [
  '[]',
  '[^]',
  '[a-z]',
  '[^a-z0-9_]',
  '[a-c-e]',
  '[-a]',
  '[a-]',
  '[--z]',
  '[\\u4e00]',
  '[\\u4e00-\\u9fff]',
  '[^\\u4e00-\\u9fff\\x41]',
  '[\\x00-\\x1f\\x7f]',
  '[\\d]',
  '[\\D]',
  '[\\w-]',
  '[\\s\\S]',
  '[^\\s]',
  '[\\d-z]',
  '[a-\\d]',
  '[\\b]',
  '[\\t-\\r]',
  '[\\cA-\\cZ]',
  '[\\c1\\c_]',
  '[\\0]',
  '[\\012]',
  '[\\0123]',
  '[\\4\\45\\456]',
  '[\\8\\9]',
  '[\\]\\\\\\-\\^]',
  '[\\.\\*]',
  '[\\ud83d\\ude00]',
  '[\\uffff]',
  '[\\ufffe-\\uffff]',
  '[\\x]',
  '[\\u12]',
  '[\\k]',
  '[\\s-a-z]',
  '[\\d-a-f]',
  '[^\\W--z]',
  '[a-\\d-z]',
  '[\\c\u4e00]',
  '[\\c-z]',
  '[\\c&]',
  '[^\\c\\\\]',
];

/** Every `[X-Y-Z]` and `[^X-Y-Z]` over atoms that mix units and class escapes. */
function hyphenated(): string[] {
  const atoms = ['a', 'f', 'z', '5', '-', '\\d', '\\s', '\\W', '\\D', '\\u0041', '\\x7a'];
  const result: string[] = [];
  for (const negation of ['', '^'])
    for (const x of atoms)
      for (const y of atoms)
        for (const z of atoms) {
          const source = `[${negation}${x}-${y}-${z}]`;
          try {
            new RegExp(source);
            result.push(source);
          } catch {
            // Out-of-order ranges are syntax errors for the engine too.
          }
        }
  return result;
}

function generated(): string[] {
  let seed = 19;
  const random = (bound: number) => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) % bound;
  };
  const items = [
    'a',
    'z',
    '-',
    '\\d',
    '\\w',
    '\\s',
    '\\D',
    '\\x41',
    '\\u4e00',
    '\\u9fff',
    '\\t',
    '\\0',
    '\\07',
    '\\cJ',
    '\\]',
    '_',
    ' ',
  ];
  const result: string[] = [];
  while (result.length < 300) {
    const body = Array.from({ length: 1 + random(6) }, () => items[random(items.length)]).join(
      '',
    );
    const source = `[${random(4) === 0 ? '^' : ''}${body}]`;
    try {
      new RegExp(source);
    } catch {
      continue;
    }
    result.push(source);
  }
  return result;
}

/** Every unit up to `last` is inside exactly the ranges the engine says it is. */
function agreesWithEngine(source: string, last: number, ignoreCase = false): boolean {
  const ranges = classRanges(source, ignoreCase);
  if (!ranges) return false;
  const native = new RegExp(source, ignoreCase ? 'i' : '');
  let next = 0;
  const beyond: [number, number] = [0x1_0000, 0x1_0000];
  for (const [low, high] of [...ranges, beyond]) {
    for (let unit = next; unit <= Math.min(high, last); unit += 1) {
      if (native.test(String.fromCharCode(unit)) !== unit >= low) {
        throw new Error(`${source} disagrees with the engine at ${unit.toString(16)}`);
      }
    }
    next = high + 1;
  }
  return true;
}

test('class ranges equal native membership over every unit, or defer to the engine', () => {
  const exact = [...WRITTEN, ...generated()].filter((source) =>
    agreesWithEngine(source, 0xffff),
  );
  // Escapes inside classes are expanded, not handed back to the engine wholesale.
  expect(exact.length).toBeGreaterThan(320);
  for (const source of ['[\\u4e00-\\u9fff]', '[\\d\\s]', '[\\0123]', '[\\c1]', '[\\s-a-z]'])
    expect(agreesWithEngine(source, 0xffff)).toBe(true);
});

test('a hyphen after a class escape joins a union, never a following range', () => {
  // Annex B consumes `escape - atom` whole; the units these forms name lie below U+3000.
  const exact = hyphenated().filter((source) => agreesWithEngine(source, 0x2fff));
  expect(exact.length).toBeGreaterThan(2_000);
});

test('under i a class folds its members before negation, exactly like the engine', () => {
  const sources = [
    ...WRITTEN,
    ...generated(),
    '[a-z]',
    '[^K]',
    '[\\u017f]',
    '[^\\u212a-\\u212b]',
    '[\\W]',
    '[^\\W]',
  ];
  const exact = sources.filter((source) => agreesWithEngine(source, 0xffff, true));
  expect(exact.length).toBeGreaterThan(320);
  for (const source of ['[^K]', '[\\u017f]', '[\\W]']) expect(exact).toContain(source);
});
