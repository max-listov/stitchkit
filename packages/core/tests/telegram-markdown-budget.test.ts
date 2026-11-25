/**
 * `markdownToTelegramHtml` is linear in its input and never recurses on the
 * input's depth: each adversarial shape converts in time that grows with its
 * size, not its square, a quote or `<details>` nested thousands deep converts
 * without a stack overflow, and every output still passes the strict check.
 *
 * Growth is measured, not a wall-clock budget: one shape is timed at 4 000,
 * 16 000 and 64 000 characters on the same machine in the same run, so a loaded
 * runner slows every size alike. Linear work takes about 4× as long for 4× the input
 * and quadratic about 16×; timing noise on a shared runner stretches linear
 * work to about 8×, so the test allows 10× and measures a ratio over it again
 * before it fails (quadratic is over it every time). A generous absolute ceiling
 * remains only to fail a hang rather than wait for it.
 */
import { describe, expect, test } from 'bun:test';
import {
  checkTelegramHtml,
  markdownToTelegramHtml,
  sanitizeTelegramHtml,
  splitTelegramHtml,
  telegramHtmlText,
} from '../src/entrypoints/telegram/html';

/** Each size is the one before it times `STEP`. */
const SIZES = [4_000, 16_000, 64_000] as const;
const STEP = 4;
const LARGEST = 64_000;
/** Linear is ~4 for the 4× input (up to ~8 measured under noise), quadratic ~16. */
const MAX_GROWTH = 10;
/** Below this the smaller run of a step is too short to time; the ceiling still holds. */
const MEASURABLE_MS = 5;
/** A hang, not a measurement. */
const CEILING_MS = 5_000;

const repeatTo = (unit: string, size: number): string =>
  unit.repeat(Math.max(1, Math.floor(size / unit.length)));

/** Backtick runs of every length 1, 2, 3… — each one unmatched, each a different closer to look for. */
function distinctBacktickRuns(size: number): string {
  let text = '';
  for (let run = 1; text.length < size; run += 1) text += `${'`'.repeat(run)}a`;
  return text;
}

const third = (size: number) => Math.floor(size / 3);
const half = (size: number) => Math.floor(size / 2);

/** Each shape at a given size; the nesting shapes grow their depth with the size. */
const ADVERSARIAL: readonly (readonly [string, (size: number) => string])[] = [
  ['unbalanced underline openers', (n) => `${repeatTo('<u>a', n - 4)}</u>`],
  ['underline openers only', (n) => repeatTo('<u>', n)],
  ['link openers without a destination end', (n) => repeatTo('[a](', n)],
  ['bare brackets', (n) => repeatTo('[', n)],
  ['link titles never closed', (n) => repeatTo('[a](x "', n)],
  ['angle destinations never closed', (n) => repeatTo('[a](<', n)],
  ['emphasis never closed', (n) => repeatTo('*a ', n)],
  ['mixed emphasis', (n) => repeatTo('**a* ', n)],
  ['underscores', (n) => repeatTo(' _a', n)],
  ['strikethrough never closed', (n) => repeatTo('~~a ', n)],
  ['links around emphasis', (n) => repeatTo('[*a](x ', n)],
  ['one long backtick run', (n) => `${'`'.repeat(third(n))}a${'``'.repeat(third(n))}`],
  ['backtick runs of distinct lengths', distinctBacktickRuns],
  ['details openers never closed', (n) => repeatTo('<details>\n', n)],
  [
    'summary openers never closed',
    (n) => `<details>\n${repeatTo('<summary>', n - 24)}\n</details>`,
  ],
  ['heading with a long space run', (n) => `# a${' '.repeat(n)}x`],
  ['table separator with a long space run', (n) => `| a |\n| -${' '.repeat(n)}x`],
  [
    'table whose padding would multiply the text',
    (n) => `| a |\n| - |\n| ${'x'.repeat(half(n))} |\n${repeatTo('|\n', half(n))}`,
  ],
  [
    'table whose missing cells would be padded to a wide column',
    (n) => `| a | b |\n| - | - |\n| ${'x'.repeat(half(n))} | |\n${repeatTo('|\n', half(n))}`,
  ],
  ['quote nested on one line', (n) => `${'>'.repeat(n / 4)} a`],
  ['quote nested with spaces', (n) => `${'> '.repeat(n / 4)}a`],
  [
    'details nested and closed',
    (n) => {
      const depth = Math.floor((n * 3) / 64);
      return `${'<details>\n'.repeat(depth)}x\n${'</details>\n'.repeat(depth)}`;
    },
  ],
  [
    'details nested on one line',
    (n) => {
      const depth = Math.floor((n * 3) / 32);
      return `${'<details>'.repeat(depth)}x${'</details>'.repeat(depth)}`;
    },
  ],
  ['code span padded and long', (n) => `\` ${'a'.repeat(n)}\``],
  [
    'summary title of spaces',
    (n) => `<details><summary>${' '.repeat(n)}x</summary>\n</details>`,
  ],
  [
    'details ending in blank lines',
    (n) => `<details>\na${'\n '.repeat(half(n))}x\n</details>`,
  ],
  ['entities', (n) => repeatTo('&#', n)],
  ['backslashes', (n) => repeatTo('\\', n)],
  ['checkbox list items', (n) => repeatTo('- [ ] \n', n)],
  ['delimiters inside words', (n) => repeatTo('a*b_c~~d||e**f ', n)],
  ['a long star run after a letter', (n) => `a${'*'.repeat(n - 2)}b`],
  ['refused links kept as text', (n) => repeatTo('[a](javascript:x) ', n)],
];

/** Milliseconds of one run of `run`. */
function timeMs(run: () => unknown): number {
  const started = performance.now();
  run();
  return performance.now() - started;
}

/**
 * The fastest of five runs at each size, taken in turns so a burst of load on the machine
 * slows every size rather than one.
 */
function timings(run: (size: number) => unknown): number[] {
  const best = SIZES.map(() => Number.POSITIVE_INFINITY);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    for (const [index, size] of SIZES.entries()) {
      best[index] = Math.min(
        best[index] ?? Number.POSITIVE_INFINITY,
        timeMs(() => run(size)),
      );
    }
    if ((best.at(-1) ?? 0) >= CEILING_MS) break;
  }
  return best;
}

/** Each step to the next size, as `[smaller ms, larger ms]`, where the smaller is long enough to time. */
function measurableSteps(best: readonly number[]): [number, number][] {
  return best.flatMap((larger, index): [number, number][] => {
    const smaller = best[index - 1];
    return smaller === undefined || smaller < MEASURABLE_MS ? [] : [[smaller, larger]];
  });
}

/**
 * Prove the growth is linear at every step. Noise only ever inflates one measurement, so a
 * step over the bound is measured again, up to three times; quadratic work is over it every
 * time. A quadratic part that a limit cuts off at a larger size still shows on the smaller step.
 */
function expectLinear(run: (size: number) => unknown): void {
  let best = timings(run);
  const over = (steps: [number, number][]) =>
    steps.filter(([smaller, larger]) => larger / smaller > MAX_GROWTH);
  for (let retry = 0; retry < 2; retry += 1) {
    if ((best.at(-1) ?? 0) >= CEILING_MS || over(measurableSteps(best)).length === 0) break;
    best = timings(run);
  }
  expect(best.at(-1)).toBeLessThan(CEILING_MS);
  expect(
    over(measurableSteps(best)).map(([smaller, larger]) => larger / smaller),
    `fastest ms at ${SIZES.join(' / ')} characters: ${best.map((ms) => ms.toFixed(1)).join(' / ')}`,
  ).toEqual([]);
}

describe('telegram markdown: linear conversion', () => {
  for (const [name, build] of ADVERSARIAL) {
    test(`${name}: each ${STEP}× the input takes at most ${MAX_GROWTH}× the time`, () => {
      const sources = new Map<number, string>(SIZES.map((size) => [size, build(size)]));
      const out = markdownToTelegramHtml(sources.get(LARGEST) ?? '');
      expect(checkTelegramHtml(out).problem).toBeUndefined();
      expect(sanitizeTelegramHtml(out)).toBe(out);
      expectLinear((size) => markdownToTelegramHtml(sources.get(size) ?? ''));
    });
  }

  test('a quote nested 16 000 deep keeps its text', () => {
    const out = markdownToTelegramHtml(`${'>'.repeat(16_000)} deepest`);
    expect(out.startsWith('<blockquote>')).toBe(true);
    expect(telegramHtmlText(out)).toEndWith('deepest');
  });

  test('a long converted text splits into valid parts, in linear time', () => {
    const unit = '**bold** _it_ `code` [link](https://example.com) <u>u</u>\n';
    const sources = new Map<number, string>(SIZES.map((size) => [size, repeatTo(unit, size)]));
    const parts = splitTelegramHtml(markdownToTelegramHtml(sources.get(LARGEST) ?? ''));
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(checkTelegramHtml(part).problem).toBeUndefined();
    expectLinear((size) => splitTelegramHtml(markdownToTelegramHtml(sources.get(size) ?? '')));
  });

  // A small limit makes many parts of each size, so work per part that grows with the whole
  // text — a walk of the tree, a scan of every atomic range — shows as growth over 4×.
  // Inputs of 16K, 64K and 256K characters: over a thousand parts at the largest.
  for (const [name, html] of [
    ['styled words', (size: number) => markdownToTelegramHtml(repeatTo('**b** _i_ ', size))],
    [
      'custom emoji',
      (size: number) =>
        repeatTo(
          '<tg-emoji emoji-id="5368324170671202286">👍</tg-emoji> a b c d e f g h i ',
          size,
        ),
    ],
  ] as const) {
    test(`${name} split into parts of 64: each ${STEP}× the input takes at most ${MAX_GROWTH}× the time`, () => {
      const sources = new Map<number, string>(SIZES.map((size) => [size, html(size * 4)]));
      const parts = splitTelegramHtml(sources.get(LARGEST) ?? '', { limit: 64 });
      expect(parts.length).toBeGreaterThan(1_000);
      for (const part of parts) {
        expect(checkTelegramHtml(part).problem).toBeUndefined();
        expect(telegramHtmlText(part).length).toBeLessThanOrEqual(64);
      }
      expectLinear((size) => splitTelegramHtml(sources.get(size) ?? '', { limit: 64 }));
    });
  }
});
