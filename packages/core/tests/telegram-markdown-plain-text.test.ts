/**
 * Plain text stays plain. A `*` or `_` inside a word — a formula, an article number, an
 * identifier — is not emphasis: a delimiter opens only where no letter or digit stands before it
 * and closes only where none follows it, for every marker. A link the link rules refuse stays
 * its own source text, visible and not a link, so nothing the author wrote is lost.
 */
import { describe, expect, test } from 'bun:test';
import {
  checkTelegramHtml,
  escapeTelegramHtml,
  markdownToTelegramHtml,
  sanitizeTelegramHtml,
  splitTelegramMarkdown,
  telegramHtmlText,
} from '../src/entrypoints/telegram/html';

const STYLE = /<(?:b|i|s|u|tg-spoiler)>/;

/** Converted, and held to what every output must be: valid and its own sanitized form. */
function convert(markdown: string): string {
  const out = markdownToTelegramHtml(markdown);
  expect(checkTelegramHtml(out).problem).toBeUndefined();
  expect(sanitizeTelegramHtml(out)).toBe(out);
  return out;
}

describe('a delimiter inside a word is text', () => {
  test('formulas, identifiers and article numbers convert to themselves', () => {
    for (const text of [
      'a*b и c*d',
      '2*3*4',
      'x**2**y',
      'snake_case_name',
      'foo__bar__baz',
      'a~~b~~c',
      'a||b||c',
      'SKU-12*34*56',
      'кот*пёс*ёж',
      // Only one edge inside a word is enough: each edge keeps its own rule.
      'a*b и c*',
      '*b и c*d',
      'x_y и z_',
      '_y и z_w',
      'p~~q и r~~',
      // A run is one delimiter, judged at its edges, not at each of its characters.
      'ж***a и b***',
      'x**a и b**',
    ])
      expect(convert(text), text).toBe(escapeTelegramHtml(text));
  });

  test('emphasis at word boundaries still converts (positive control)', () => {
    expect(convert('**жирный** и *курсив*')).toBe('<b>жирный</b> и <i>курсив</i>');
    expect(convert('_курсив_, __жирный__ ~~зачёркнуто~~ ||спойлер||')).toBe(
      '<i>курсив</i>, <b>жирный</b> <s>зачёркнуто</s> <tg-spoiler>спойлер</tg-spoiler>',
    );
    expect(convert('(**b**) «*i*» ***bi***.')).toBe('(<b>b</b>) «<i>i</i>» <b><i>bi</i></b>.');
  });

  test('random words with delimiters inside them never become a style', () => {
    let seed = 20_261_125;
    const next = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) >>> 0;
      return seed / 2 ** 32;
    };
    const letters = ['a', 'z', '7', 'ж', 'é', 'Ω'];
    const markers = ['*', '**', '***', '_', '__', '~~', '||'];
    const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
    for (let round = 0; round < 3_000; round += 1) {
      const words = Array.from({ length: 1 + Math.floor(next() * 5) }, () => {
        let word = pick(letters);
        for (let part = 0; part < 1 + Math.floor(next() * 3); part += 1)
          word += `${pick(markers)}${pick(letters)}${pick(letters)}`;
        return word;
      });
      const text = words.join(pick([' ', ', ', ' и ']));
      const out = convert(text);
      expect(out, text).not.toMatch(STYLE);
      expect(telegramHtmlText(out), text).toBe(text);
      // Markdown left as Markdown is cut by lines and never rewritten.
      expect(splitTelegramMarkdown(text, { limit: 4_096 }).join('\n'), text).toBe(text);
    }
  });
});

describe('a link the link rules refuse is its own source text', () => {
  test('the source stays visible, escaped, and is not a link', () => {
    for (const source of [
      '[клик](javascript:alert(1))',
      '[click](data:text/html,<script>alert(1)</script>)',
      '[a](https://)',
      '[b](https://[::1)',
      '[c](tg:)',
      '[d](not-a-url)',
      '[e](/relative/path)',
      '[f](<https://x.test/a b>)',
      '![g](javascript:alert(1))',
    ]) {
      const out = convert(source);
      expect(out, source).not.toContain('<a');
      expect(telegramHtmlText(out), source).toBe(source);
    }
    expect(convert('see [клик](javascript:alert(1)).')).toBe(
      'see [клик](javascript:alert(1)).',
    );
  });

  test('a link the rules keep is still a link (positive control)', () => {
    expect(convert('[docs](https://example.com) [me](tg://user?id=1)')).toBe(
      '<a href="https://example.com">docs</a> <a href="tg://user?id=1">me</a>',
    );
  });

  test('a literal double quote in a Markdown destination leaves the whole link visible', () => {
    for (const source of [
      '[**notes**](https://example.com/"draft")',
      '[notes](<https://example.com/?q="draft"> "title")',
    ]) {
      const out = convert(source);
      expect(out).toBe(escapeTelegramHtml(source));
      expect(telegramHtmlText(out)).toBe(source);
    }
  });

  test('percent escapes, quote entities, and quotes in a label or title still allow a link', () => {
    expect(convert('["notes"](https://example.com/%22draft%22 "title")')).toBe(
      '<a href="https://example.com/%22draft%22">&quot;notes&quot;</a>',
    );
    expect(convert('[notes](https://example.com/?q=&quot;draft&quot;)')).toBe(
      '<a href="https://example.com/?q=&quot;draft&quot;">notes</a>',
    );
  });
});
