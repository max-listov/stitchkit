import { expect, test } from 'bun:test';
import { MAX_REGEX_STATES } from '../src/agent-runtime/coding-search-automaton';
import {
  backtrackingWork,
  compileLinearSearchRegex,
  compileSearchRegex,
  MAX_NATIVE_LINE_WORK,
} from '../src/agent-runtime/coding-search-matcher';
import {
  MAX_REGEX_REPEAT,
  parseSearchRegex,
} from '../src/agent-runtime/coding-search-regex-syntax';

const unchecked = () => undefined;

function refusal(pattern: string): string {
  try {
    compileLinearSearchRegex(pattern, unchecked);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error(`Expected ${pattern} to refuse`);
}

const WRITTEN = [
  'name.*value',
  '^import .* from',
  'foo|bar',
  '(foo|ba)r',
  '(?:ab)+c',
  '(?<word>ab)c',
  'a{2}',
  'a{2,}',
  'a{1,3}b',
  'a{,3}',
  'x{',
  '}',
  ']',
  '[]a]',
  '[^]',
  '[]',
  '[a-c-e]',
  '[\\d-z]',
  '[\\]]',
  '[\\b]',
  '\\bword\\b',
  '\\Bor\\B',
  '^$',
  '^',
  '$',
  'a?',
  'a*?b',
  'a+?',
  '(a*)*b',
  '(a|)+',
  '(|a)b',
  '()',
  '\\d+\\.\\d*',
  '\\w+\\s\\S',
  '\\D\\W',
  '\\x41\\u0042',
  '\\x4',
  '\\u12',
  '\\u{2}',
  '\\cJ',
  '\\c1',
  '\\c*',
  '[\\c1]',
  '\\0',
  '\\01',
  '\\012',
  '\\0123',
  '\\08',
  '\\k',
  '\\kb',
  '(?i:ab)c',
  '(?i:[a-c]x)',
  '(?s:.)',
  '(?m:^b)',
  '(?m:a$)',
  '(?m:^$)',
  '(?i-s:a.)',
  '(?i:a(?-i:b))',
  '(?ims:^A.$)',
  '\\t\\n\\r\\v\\f',
  '\\.\\*\\+\\?\\(\\)\\[\\]\\{\\}\\|\\^\\$\\\\',
  '\\/',
  '\\a\\e\\q',
  '.',
  '..+',
  '😀',
  '[😀]',
  'a|b|c|',
  '(a(b(c)))',
  '[^a-z]+$',
];

const SUBJECTS = [
  '',
  'a',
  'aa',
  'aaab',
  'ab',
  'abc',
  'abab c',
  'foo',
  'bar',
  'bazr',
  'fooobar',
  'name = value',
  'import x from "y"',
  'word',
  'a word here',
  'sword',
  'x{',
  '}',
  ']',
  'b',
  '12.5',
  '1.',
  'AB',
  'J',
  '\n',
  'line\nnext',
  '\t\n\r\v\f',
  '.*+?()[]{}|^$\\',
  '/',
  'aeq',
  '😀',
  '\ud83d',
  'abc',
  'ABC!',
  'u',
  'uu',
  'x4',
  '\0',
  'c-e',
  '\b',
  '\\c1',
  '\\cc',
  '\x01',
  '\n',
  '\n3',
  '\0' + '8',
  'kb',
  'ABc',
  'Bx',
  'a\nb',
  'a\rB',
  'A\u2028',
  'aB',
];

test('written patterns match exactly what native RegExp matches', () => {
  let compared = 0;
  for (const pattern of WRITTEN) {
    const native = new RegExp(pattern);
    const linear = compileLinearSearchRegex(pattern, unchecked);
    for (const subject of SUBJECTS) {
      expect({ pattern, subject, matched: linear.test(subject) }).toEqual({
        pattern,
        subject,
        matched: native.test(subject),
      });
      compared += 1;
    }
  }
  expect(compared).toBe(WRITTEN.length * SUBJECTS.length);
});

test('generated patterns agree with native RegExp on generated lines', () => {
  let seed = 0x5eed;
  const random = (bound: number) => {
    seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
    return seed % bound;
  };
  const tokens = [
    'a',
    'b',
    '.',
    '\\d',
    '\\w',
    '\\s',
    '[ab]',
    '(?i:',
    '(?m:',
    '(?s:',
    'A',
    '\n',
    '[^a]',
    '^',
    '$',
    '\\b',
    '(',
    ')',
    '|',
    '*',
    '+',
    '?',
    '{1,2}',
    '{2}',
    '(?:',
    '_',
    '1',
    ' ',
  ];
  const alphabet = ['a', 'b', 'A', '1', ' ', '_', '\n', '\r', '-'];
  let compared = 0;
  let generated = 0;
  while (generated < 600) {
    const pattern = Array.from(
      { length: 1 + random(9) },
      () => tokens[random(tokens.length)],
    ).join('');
    try {
      new RegExp(pattern);
    } catch {
      continue;
    }
    generated += 1;
    const native = new RegExp(pattern);
    const linear = compileLinearSearchRegex(pattern, unchecked);
    for (let line = 0; line < 30; line += 1) {
      const subject = Array.from(
        { length: random(12) },
        () => alphabet[random(alphabet.length)],
      ).join('');
      if (linear.test(subject) !== native.test(subject)) {
        throw new Error(
          `Mismatch for ${JSON.stringify(pattern)} on ${JSON.stringify(subject)}`,
        );
      }
      compared += 1;
    }
  }
  expect(compared).toBe(600 * 30);
});

test('catastrophic backtracking patterns finish linearly', () => {
  const subject = `${'a'.repeat(8_000)}!`;
  for (const pattern of ['(a+)+$', '^(a|a)*$', '(a*)*b', '^(a|aa)+$', '(.*a){20}$']) {
    const started = performance.now();
    expect(compileLinearSearchRegex(pattern, unchecked).test(subject)).toBe(false);
    expect(performance.now() - started).toBeLessThan(2_000);
  }
});

test('matching observes the caller deadline inside one line', () => {
  let checks = 0;
  const stop = new Error('deadline');
  const matcher = compileLinearSearchRegex('(.*a){20}$', () => {
    checks += 1;
    if (checks > 10) throw stop;
  });
  expect(() => matcher.test(`${'a'.repeat(100_000)}!`)).toThrow(stop);
  expect(checks).toBe(11);
});

test('constructs that need backtracking or lookaround refuse before matching', () => {
  expect(refusal('(a)\\1')).toContain('backreference');
  expect(refusal('(?<n>a)\\k<n>')).toContain('backreference');
  expect(refusal('a(?=b)')).toContain('lookaround');
  expect(refusal('a(?!b)')).toContain('lookaround');
  expect(refusal('(?<=a)b')).toContain('lookaround');
  expect(refusal('(?<!a)b')).toContain('lookaround');
  expect(refusal(`a{${MAX_REGEX_REPEAT + 1}}`)).toContain('repetition');
  expect(refusal('(?:(?:(?:(?:){1000}){1000}){1000}){1000}')).toContain('construction steps');
  const nested = Array.from(
    { length: 3_000 },
    (_, index) =>
      `[${String.fromCharCode(0x4e00 + index)}-${String.fromCharCode(0x9fff - index)}]`,
  ).join('|');
  expect(refusal(nested)).toContain('overlap too much');
  expect(refusal('(a{1000}){20}')).toContain(`${MAX_REGEX_STATES}`);
  expect(refusal('[unclosed')).toBe('This pattern is not a valid regular expression');
});

test('construction observes the caller deadline and its own step ceiling', () => {
  let checks = 0;
  const stop = new Error('deadline');
  expect(() =>
    compileLinearSearchRegex('(?:(?:(?:){100}){100}){100}', () => {
      checks += 1;
      if (checks > 3) throw stop;
    }),
  ).toThrow(stop);
  expect(checks).toBe(4);
});

test('an invalid pattern refusal carries the engine reason and cause', () => {
  let caught: unknown;
  try {
    compileLinearSearchRegex('(unclosed', unchecked);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect(caught instanceof Error && caught.cause).toBeInstanceOf(SyntaxError);
  expect(JSON.stringify(caught)).toContain('Invalid regular expression');
});

test('cached transitions keep ordinary searches near native throughput', () => {
  const line = 'const value = await import(name) from fixme return TODOX';
  const lines = Array.from({ length: 150_000 }, (_, index) => `${line} ${index}`);
  for (const pattern of ['TODO|FIXME', 'name.*value', '\\bimport\\b.*from']) {
    const matcher = compileLinearSearchRegex(pattern, unchecked);
    const started = performance.now();
    for (const text of lines) matcher.test(text);
    // About 9 MB per pattern; a per-unit closure walk took seconds here.
    expect(performance.now() - started).toBeLessThan(1_000);
  }
});

test('a large alphabet shares transitions by class, keeping time and the cache bounded', () => {
  // xorshift32: exact in 32-bit integers, so every one of the 20,000 units occurs.
  let seed = 11;
  const random = (bound: number) => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) % bound;
  };
  // Random CJK units mixed half and half with `a`: one transition per distinct unit misses
  // the cache on almost every unit and walks a closure each time (about ten times slower).
  const lines = Array.from({ length: 2_000 }, () =>
    String.fromCharCode(
      ...Array.from({ length: 2_700 }, () => (random(2) === 0 ? 97 : 0x4e00 + random(20_000))),
    ),
  );
  // Native backtracking takes tens of seconds on the second pattern, so its expected
  // answer is stated directly: an `a` exactly eleven units before the end.
  const expected: [pattern: string, matches: (line: string) => boolean][] = [
    ['a.{10}z', (line) => /a.{10}z/.test(line)],
    ['(?:[\\u4e00-\\u9fff]|a)*a.{10}$', (line) => line.at(-11) === 'a'],
  ];
  for (const [pattern, matches] of expected) {
    const matcher = compileLinearSearchRegex(pattern, unchecked);
    const started = performance.now();
    const matched = lines.map((line) => matcher.test(line));
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(matched).toEqual(lines.map(matches));
  }
});

test('case-insensitive literals fold exactly like native RegExp without the u flag', () => {
  // Every unit of the blocks that have case, against itself and its neighbours, plus the folds
  // that differ between Unicode-aware and legacy matching (long s, Kelvin sign, sharp s, dotted
  // and dotless i, micro sign, final sigma) against all 65,536 units.
  const cased = [
    [0x0000, 0x058f],
    [0x10a0, 0x10ff],
    [0x13a0, 0x13ff],
    [0x1c80, 0x1cbf],
    [0x1d00, 0x1fff],
    [0x2100, 0x218f],
    [0x24b0, 0x24ff],
    [0x2c00, 0x2d2f],
    [0xa640, 0xa7ff],
    [0xab70, 0xabbf],
    [0xff00, 0xff5f],
  ];
  let compared = 0;
  for (const [low, high] of cased) {
    for (let code = low ?? 0; code <= (high ?? 0); code += 1) {
      const source = `\\u${code.toString(16).padStart(4, '0')}`;
      const linear = compileLinearSearchRegex(`(?i:${source})`, unchecked);
      const native = new RegExp(source, 'i');
      for (const other of [
        code,
        code ^ 0x20,
        code ^ 1,
        code + 1,
        code - 1,
        code + 0x50,
        code - 0x50,
      ]) {
        if (other < 0 || other > 0xffff) continue;
        const subject = String.fromCharCode(other);
        if (linear.test(subject) !== native.test(subject)) {
          throw new Error(`Fold mismatch for ${code.toString(16)} on ${other.toString(16)}`);
        }
        compared += 1;
      }
    }
  }
  for (const code of [
    0x17f, 0x212a, 0xdf, 0x1e9e, 0x130, 0x131, 0xb5, 0x3bc, 0x3c2, 0x3c3, 0x69, 0x73, 0x6b,
  ]) {
    const source = String.fromCharCode(code);
    const linear = compileLinearSearchRegex(`(?i:${source})`, unchecked);
    const native = new RegExp(source, 'i');
    for (let other = 0; other <= 0xffff; other += 1) {
      const subject = String.fromCharCode(other);
      if (linear.test(subject) !== native.test(subject)) {
        throw new Error(`Fold mismatch for ${code.toString(16)} on ${other.toString(16)}`);
      }
      compared += 1;
    }
  }
  expect(compared).toBeGreaterThan(13 * 0x10000);
}, 60_000);

test('thousands of literals or overlapping ranges cost their endpoints, not atoms × units', () => {
  let seed = 7;
  const random = (bound: number) => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) % bound;
  };
  const lines = Array.from({ length: 600 }, () =>
    String.fromCharCode(...Array.from({ length: 2_700 }, () => 0x4e00 + random(20_000))),
  );
  const cjk = (offset: number) => String.fromCharCode(0x4e00 + offset);
  const literals = Array.from({ length: 8_000 }, (_, index) => cjk(index));
  const patterns = [
    `(?:${Array.from({ length: 1_333 }, (_, index) => `[${cjk(index * 3)}-${cjk(index * 3 + 2_000)}]`).join('|')})zz`,
    literals.join(''),
    `(?:${literals.join('|')})zz`,
    `(?i:${literals.slice(0, 2_000).join('|')})zz`,
    `${literals
      .slice(0, 1_637)
      .map((literal) => `[\\c${literal}]`)
      .join('')}x+`,
    `(?:${literals
      .slice(0, 1_000)
      .map((literal, index) => `${['.', '\\d', '\\W', '\\s'][index % 4]}${literal}`)
      .join('|')})+z`,
    `(?i:${literals
      .slice(0, 2_725)
      .map((literal) => `[${literal}]`)
      .join('')})x+`,
    literals
      .slice(0, 1_365)
      .map((literal) => `\\u${literal.charCodeAt(0).toString(16)}`)
      .join(''),
  ];
  for (const pattern of patterns) {
    Bun.gc(true);
    const before = process.memoryUsage().heapUsed;
    const started = performance.now();
    const matcher = compileLinearSearchRegex(pattern, unchecked);
    expect(lines.some((line) => matcher.test(line))).toBe(false);
    expect(performance.now() - started).toBeLessThan(2_000);
    Bun.gc(true);
    // The matcher is still reachable here, so its tables are counted.
    expect(matcher.test('zz') || process.memoryUsage().heapUsed - before < 96 * 2 ** 20).toBe(
      true,
    );
  }
});

test('patterns without repetition run natively within their backtracking bound', () => {
  let seed = 3;
  const random = (bound: number) => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) % bound;
  };
  const lines = Array.from({ length: 1_600 }, () =>
    String.fromCharCode(...Array.from({ length: 1_000 }, () => 0x4e00 + random(20_000))),
  );
  const cjk = (offset: number) => String.fromCharCode(0x4e00 + offset);
  // Each alternative opens with a unit matching almost anything, so the automaton meets a new
  // deterministic state at nearly every unit; backtracking tries each alternative once.
  const wide = `(?:${Array.from({ length: 2_046 }, (_, index) => `.${cjk(index)}z`).join('|')})`;
  // Paths × path length × the 1,024-unit length bucket of a 1,000-unit line.
  expect(2_046 * 3 * 1_024).toBeLessThanOrEqual(MAX_NATIVE_LINE_WORK);
  for (const pattern of [wide, '..\u4e00z', '\\b.(?m:^)\\B.z']) {
    const native = new RegExp(pattern);
    const matcher = compileSearchRegex(pattern, unchecked);
    const started = performance.now();
    expect(lines.map((line) => matcher.test(line))).toEqual(
      lines.map((line) => native.test(line)),
    );
    expect(performance.now() - started).toBeLessThan(1_000);
  }
  let checks = 0;
  const counted = compileSearchRegex('foo|bar', () => {
    checks += 1;
  });
  for (const line of ['foo', 'baz', 'bar']) counted.test(line);
  expect(checks).toBe(3);
  // Repetition is never handed to the backtracking engine: natively this takes seconds.
  const started = performance.now();
  const repeated = compileSearchRegex('(?:[\\u4e00-\\u9fff]|a)*a.{10}$', unchecked);
  const mixed = Array.from({ length: 12 }, () =>
    String.fromCharCode(
      ...Array.from({ length: 8_000 }, () =>
        random(50) === 0 ? 97 : 0x4e00 + random(20_000),
      ),
    ),
  );
  expect(mixed.map((line) => repeated.test(line))).toEqual(
    mixed.map((line) => line.at(-11) === 'a'),
  );
  expect(performance.now() - started).toBeLessThan(1_000);
});

test('counted repetition is bounded backtracking and runs natively within the bound', () => {
  let seed = 23;
  const random = (bound: number) => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) % bound;
  };
  const lines = Array.from({ length: 960 }, () =>
    Array.from({ length: 1_000 }, () => (random(2) === 0 ? 'a' : 'x')).join(''),
  );
  // A frequent opener before a counted gap gives the automaton one state per subset of gap
  // positions; backtracking spends at most the gap per start position.
  for (const pattern of [
    'a.{0,100}zq',
    'a.{300}b',
    'a.{999}b',
    'a[ax]{200}a[ax]{200}b',
    '(?:ab?){0,3}x{2}z',
  ]) {
    const native = new RegExp(pattern);
    const matcher = compileSearchRegex(pattern, unchecked);
    const started = performance.now();
    expect(lines.map((line) => matcher.test(line))).toEqual(
      lines.map((line) => native.test(line)),
    );
    expect(performance.now() - started).toBeLessThan(1_000);
  }
});

test('on a short line repetition is capped by the line, so code-sized lines run natively', () => {
  let seed = 29;
  const random = (bound: number) => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) % bound;
  };
  const words = [
    'const',
    'value',
    'import',
    'from',
    'return',
    'events',
    'await',
    'name',
    '(',
    ')',
  ];
  const lines = Array.from({ length: 100_000 }, () =>
    Array.from({ length: 2 + random(6) }, () => words[random(words.length)]).join(' '),
  );
  // A gap far beyond the line makes the automaton walk one state set per frequent `e`.
  for (const pattern of ['e.{0,1000}zq', '(?:a|e).{0,300}(?:x|q)z', 'name.*value']) {
    const native = new RegExp(pattern);
    const matcher = compileSearchRegex(pattern, unchecked);
    expect(lines.map((line) => matcher.test(line))).toEqual(
      lines.map((line) => native.test(line)),
    );
  }
  // Relative to the automaton on the same lines, so machine load cannot decide the result.
  for (const pattern of ['e.{0,1000}zq', '(?:a|e).{0,300}(?:x|q)z']) {
    const linear = compileLinearSearchRegex(pattern, unchecked);
    const matcher = compileSearchRegex(pattern, unchecked);
    let started = performance.now();
    for (const line of lines) linear.test(line);
    const automatonMs = performance.now() - started;
    started = performance.now();
    for (const line of lines) matcher.test(line);
    expect(performance.now() - started).toBeLessThan(automatonMs / 3);
  }
  // `*` is bounded by the line too: ordinary `.*` searches keep the native engine's speed.
  const repeated = lines.flatMap((line) => [line, line, line, line, line]);
  for (const pattern of ['name.*value', '\\bimport\\b.*from', 'zzqqxx.*yy']) {
    const matcher = compileSearchRegex(pattern, unchecked);
    const linear = compileLinearSearchRegex(pattern, unchecked);
    let started = performance.now();
    for (const line of repeated) linear.test(line);
    const automatonMs = performance.now() - started;
    started = performance.now();
    for (const line of repeated) matcher.test(line);
    expect(performance.now() - started).toBeLessThan(automatonMs / 3);
  }
});

test('a repetition whose body can match empty keeps its required iterations in the bound', () => {
  // Required iterations run even when they match empty; under-counting them hands the line to
  // a backtracking engine that gives up after its own limit and answers false.
  for (const pattern of ['(?:|){40}x', '(?:\\b|){40}x', '(?:a?){40}x', '(?:(?:)*){30}x']) {
    const linear = compileLinearSearchRegex(pattern, unchecked);
    const matcher = compileSearchRegex(pattern, unchecked);
    for (const line of ['aaax', 'bbbx', 'x', 'aaa']) {
      const started = performance.now();
      expect({ pattern, line, matched: matcher.test(line) }).toEqual({
        pattern,
        line,
        matched: linear.test(line),
      });
      expect(performance.now() - started).toBeLessThan(200);
    }
  }
  // An iteration that consumes nothing is still a step: nested empty repetition is a billion
  // steps per start, never a native line, and the automaton refuses to build it.
  for (const pattern of [
    '(?:(?:(?:){1000}){1000}){1000}x',
    '(?:(?:(?:(?:){1000}){1000}){1000}){1000}',
  ])
    expect(() => compileSearchRegex(pattern, unchecked)).toThrow('construction steps');
});

test('an alternation of disjoint single units costs one path, like the class it spells', () => {
  const work = (pattern: string, units: number) =>
    backtrackingWork(parseSearchRegex(pattern, unchecked), units);
  for (const units of [16, 128, 8_192]) {
    expect(work('(?:\\w|-)+.{0,20}zq', units).paths).toBe(
      work('[\\w-]+.{0,20}zq', units).paths,
    );
    expect(work('(?:[a-z]|_|\\d)+', units).paths).toBe(work('[a-z_\\d]+', units).paths);
    // Overlapping alternatives can both continue, so each keeps its path.
    expect(work('(?:a|[ab])+', units).paths).toBeGreaterThan(work('[ab]+', units).paths);
  }
  for (const pattern of [
    '(?:\\w|-)+.{0,20}zq',
    '(?:[a-z]|_)+\\(.{0,80}\\)zq',
    '(?:a|[ab])+c',
  ]) {
    const native = new RegExp(pattern);
    const matcher = compileSearchRegex(pattern, unchecked);
    for (const line of ['import-map(x) zq', 'aab', `${'ab'.repeat(200)}c`, 'name_1(value) zq'])
      expect(matcher.test(line)).toBe(native.test(line));
  }
});

test('a native line stays far below the engine backtracking limit, never answering a silent false', () => {
  // Zero-width group iterations are what the engine counts against its own limit; each copy of
  // the block adds 1,000 of them per start position on a 8,192-unit line.
  const line = 'a!'.repeat(4_096);
  for (let copies = 1; copies <= 16; copies += 1) {
    const pattern = `${'(?:\\b){1000}'.repeat(copies)}!$`;
    const linear = compileLinearSearchRegex(pattern, unchecked);
    expect({ copies, matched: compileSearchRegex(pattern, unchecked).test(line) }).toEqual({
      copies,
      matched: linear.test(line),
    });
  }
});

test('deep group nesting counts in a native line cost, so one line never stalls for seconds', () => {
  // The engine pays each enclosing group on every step inside it; uncounted, d = 64 costs
  // several seconds per 8,192-unit line with the event loop blocked.
  const line = 'a!'.repeat(4_096);
  for (const depth of [1, 16, 64]) {
    const pattern = `(?:${'('.repeat(depth)}\\b${')'.repeat(depth)}){1000}!$`;
    const matcher = compileSearchRegex(pattern, unchecked);
    const started = performance.now();
    expect(matcher.test(line)).toBe(compileLinearSearchRegex(pattern, unchecked).test(line));
    expect(performance.now() - started).toBeLessThan(1_500);
  }
});

test('many groups inside a repeated body count in a native line cost, as deep nesting does', () => {
  // The engine saves every group of a repeated body on each iteration; three thousand empty
  // groups made one 8,192-unit native line take tens of seconds. Counted, that pattern needs the
  // automaton, which refuses to build it rather than stalling.
  const line = 'a!'.repeat(4_096);
  for (const width of [1, 100]) {
    const pattern = `(?:\\b${'()'.repeat(width)}){100}!$`;
    const matcher = compileSearchRegex(pattern, unchecked);
    const started = performance.now();
    expect(matcher.test(line)).toBe(compileLinearSearchRegex(pattern, unchecked).test(line));
    expect(performance.now() - started).toBeLessThan(1_500);
  }
  expect(() => compileSearchRegex(`(?:\\b${'()'.repeat(3_000)}){100}!$`, unchecked)).toThrow(
    'construction steps',
  );
});
