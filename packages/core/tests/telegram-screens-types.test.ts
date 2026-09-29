/**
 * Telegram screens: what the compiler refuses, and what the bundle never holds.
 *
 * The declarations below are checked by `tsc` over the test tree: each
 * `@ts-expect-error` is a promise that the line does not compile, and it fails
 * the typecheck the day the line starts compiling.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Context } from 'grammy';
import { z } from 'zod';
import { back, html, link, telegramScreens } from '../src/entrypoints/telegram/screens';

const tg = telegramScreens<Context>();
const home = tg.screen('/').view(() => ({ text: 'home' }));
const item = tg
  .screen('/item/:itemId')
  .load((c) => ({ name: c.params.itemId }))
  .action('rename', z.object({ name: z.string(), loud: z.boolean().optional() }), (c) => {
    const name: string = c.input.name;
    void name;
  })
  .action('drop', () => undefined)
  .view(({ data, act, params }) => {
    const name: string = data.name;
    const id: string = params.itemId;
    return {
      text: html`${name} ${id}`,
      keyboard: [
        [act.rename('Rename', { name: 'x' }), act.drop('Drop')],
        // @ts-expect-error — an action with an input schema needs its input
        [act.rename('Rename')],
        // @ts-expect-error — the input is typed by the schema
        [act.rename('Rename', { name: 1 })],
        // @ts-expect-error — an action without a schema takes no input
        [act.drop('Drop', { any: 1 })],
        // @ts-expect-error — only declared actions have buttons
        [act.missing('Missing')],
        [back('« Back')],
      ],
    };
  });
const numbered = tg
  .group('/page/:n', { params: z.object({ n: z.coerce.number().int() }) })
  .load((c) => ({ page: c.params.n }))
  .screen('/')
  .view(({ data }) => {
    const page: number = data.page;
    return { text: String(page) };
  });

/** Never called: a load after an action does not compile, so there is nothing to run. */
export function late() {
  return (
    tg
      .screen('/late')
      .action('go', () => undefined)
      // @ts-expect-error — a load comes before actions: they run on what it loaded
      .load(() => ({}))
  );
}

export const refusedSchemas = [
  // @ts-expect-error — a params schema must accept its own output: the button carries it back
  tg.screen('/to/:n', { params: z.object({ n: z.string().transform(Number) }) }),
  // @ts-expect-error — the same holds for a group
  tg.group('/gt/:n', { params: z.object({ n: z.string().transform(Number) }) }),
  tg.screen('/co/:n', { params: z.object({ n: z.coerce.number() }) }),
];

export const links = [
  link('Home', home),
  link('Item', item, { itemId: 'a' }),
  link('Page', numbered, { n: 2 }),
  // @ts-expect-error — the path has params, so the link must carry them
  link('Item', item),
  // @ts-expect-error — the param names come from the path literal
  link('Item', item, { id: 'a' }),
  // @ts-expect-error — a screen without params takes none
  link('Home', home, { itemId: 'a' }),
];

export const views = [
  // @ts-expect-error — a view message has exactly one content
  tg.screen('/both').view(() => ({ text: 'a', photo: 'file' })),
  tg
    .screen('/rows')
    .view(() => ({ text: 'a', keyboard: [false, null, [undefined, back('«')]] })),
];

describe('telegram screens: the compiler', () => {
  test('the declarations above typecheck with exactly the refusals marked', () => {
    expect(links).toHaveLength(6);
    expect(views).toHaveLength(2);
    expect(refusedSchemas).toHaveLength(3);
    expect(typeof late).toBe('function');
  });
});

describe('telegram screens: grammY is a type, never a run-time import', () => {
  const ROOT = `${import.meta.dir}/../src/telegram`;
  const files = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? files(join(directory, entry.name))
        : entry.name.endsWith('.ts')
          ? [join(directory, entry.name)]
          : [],
    );
  const GRAMMY = String.raw`'(grammy(?:\/[^']*)?)'`;
  const valueImports = (source: string): string[] => [
    // import { Bot } from 'grammy' — and not `import type`, nor only `type` names
    ...[
      ...source.matchAll(
        new RegExp(
          String.raw`^(?:import|export)\s+(?!type\b)([^;]*?)\s+from\s+${GRAMMY}`,
          'gms',
        ),
      ),
    ]
      .filter((match) => !/^\{\s*(?:type\s+[^,}]+,?\s*)+\}$/.test(match[1] ?? ''))
      .map((match) => match[2] ?? ''),
    // import 'grammy' — for its side effects
    ...[...source.matchAll(new RegExp(String.raw`^import\s+${GRAMMY}`, 'gm'))].map(
      (match) => match[1] ?? '',
    ),
    // await import('grammy')
    ...[...source.matchAll(new RegExp(String.raw`\bimport\(\s*${GRAMMY}\s*\)`, 'g'))].map(
      (match) => match[1] ?? '',
    ),
  ];

  test('no file of the telegram part imports grammY as a value', () => {
    const offenders = files(ROOT).filter(
      (file) => valueImports(readFileSync(file, 'utf8')).length > 0,
    );
    expect(offenders).toEqual([]);
  });

  test('the check sees a value import (negative control)', () => {
    expect(valueImports("import { Bot } from 'grammy';\n")).toEqual(['grammy']);
    expect(valueImports("import { type Bot, InlineKeyboard } from 'grammy';\n")).toEqual([
      'grammy',
    ]);
    expect(valueImports("import type { Bot } from 'grammy';\n")).toEqual([]);
    expect(valueImports("import { type Bot } from 'grammy/types';\n")).toEqual([]);
    expect(valueImports("export { Bot } from 'grammy';\n")).toEqual(['grammy']);
    expect(valueImports("export type { Bot } from 'grammy';\n")).toEqual([]);
    expect(valueImports("import 'grammy';\n")).toEqual(['grammy']);
    expect(valueImports("const g = await import('grammy');\n")).toEqual(['grammy']);
  });
});
