/**
 * `stitchkit/telegram/html`: any markup into what Telegram accepts, cut to its
 * limits by what the reader sees, every part valid on its own.
 */
import { describe, expect, test } from 'bun:test';
import {
  checkTelegramHtml,
  escapeTelegramHtml,
  parseTelegramHtml,
  renderTelegramHtml,
  sanitizeTelegramHtml,
  splitTelegramHtml,
  TELEGRAM_CAPTION_LIMIT,
  telegramHtmlText,
  truncateTelegramHtml,
} from '../src/entrypoints/telegram/html';

/** Every part passes the strict check: what Telegram would parse without refusing. */
function expectAccepted(parts: readonly string[]): void {
  for (const part of parts) expect(checkTelegramHtml(part).problem).toBeUndefined();
}

describe('telegram html: cleaning', () => {
  test('keeps what Telegram accepts, renames synonyms and drops the rest with its words kept', () => {
    expect(
      sanitizeTelegramHtml('<script>alert(1)</script><strong>Bold</strong><br><em>it</em>'),
    ).toBe('alert(1)<b>Bold</b>\n<i>it</i>');
    expect(sanitizeTelegramHtml('<ins>u</ins><strike>s</strike><del>d</del>')).toBe(
      '<u>u</u><s>s</s><s>d</s>',
    );
  });

  test('block tags become line breaks, a paragraph two, never leading or trailing', () => {
    expect(
      sanitizeTelegramHtml('<p>one</p><p>two</p><div>three</div>four<br><br>five<p></p>'),
    ).toBe('one\n\ntwo\n\nthree\nfour\n\nfive');
  });

  test('a closing tag closes what it names and what is open inside it; a stray one is ignored', () => {
    expect(sanitizeTelegramHtml('<b><i>text</b> & more</i>')).toBe(
      '<b><i>text</i></b> &amp; more',
    );
    expect(sanitizeTelegramHtml('plain</b> text')).toBe('plain text');
    expect(sanitizeTelegramHtml('one<br/>two<br />three<b/>')).toBe('one\ntwo\nthree');
  });

  test('a link keeps only an href Telegram opens; attributes and other tags are gone', () => {
    const result = sanitizeTelegramHtml(
      '<a href="javascript:alert(1)">click</a><img src=x onerror=secret> <a href="https://x.test/?a=1&amp;b=2" onclick="y">ok</a> <a href="tg://user?id=1">me</a>',
    );
    expect(result).toBe(
      'click <a href="https://x.test/?a=1&amp;b=2">ok</a> <a href="tg://user?id=1">me</a>',
    );
    expect(result).not.toContain('onerror');
    expect(result).not.toContain('onclick');
  });

  test('entities nest only where Telegram lets them', () => {
    // Nothing inside code or pre; links, quotes and code never inside each other.
    expect(sanitizeTelegramHtml('<code><b>x</b></code>')).toBe('<code>x</code>');
    expect(sanitizeTelegramHtml('<a href="https://x.test">l <code>c</code></a>')).toBe(
      '<a href="https://x.test">l c</a>',
    );
    expect(
      sanitizeTelegramHtml('<blockquote>q <blockquote>in</blockquote></blockquote>'),
    ).toBe('<blockquote>q in</blockquote>');
    // Styles nest freely, and hold anything.
    expect(sanitizeTelegramHtml('<b>b <i>i <a href="https://x.test">l</a></i></b>')).toBe(
      '<b>b <i>i <a href="https://x.test">l</a></i></b>',
    );
    expect(sanitizeTelegramHtml('<b><blockquote>q</blockquote></b>')).toBe(
      '<b><blockquote>q</blockquote></b>',
    );
  });

  test('every tag Telegram documents survives with its attributes', () => {
    const markup =
      '<tg-spoiler>a</tg-spoiler><pre><code class="language-python">x = 1</code></pre>' +
      '<blockquote expandable>q</blockquote><tg-emoji emoji-id="5368324170671202286">👍</tg-emoji>' +
      '<tg-time unix="1647531900" format="wDT">then</tg-time>';
    expect(sanitizeTelegramHtml(markup)).toBe(markup);
    expect(sanitizeTelegramHtml('<span class="tg-spoiler">s</span><span>plain</span>')).toBe(
      '<tg-spoiler>s</tg-spoiler>plain',
    );
    // A format Telegram would refuse is dropped; a time without its instant is text.
    expect(
      sanitizeTelegramHtml('<tg-time unix="1" format="xyz">t</tg-time><tg-time>n</tg-time>'),
    ).toBe('<tg-time unix="1">t</tg-time>n');
  });

  test('entities decode into text and re-escape; a bare < or & becomes text', () => {
    expect(sanitizeTelegramHtml('a < b &amp;&amp; &#128512; &bogus; &quot;')).toBe(
      'a &lt; b &amp;&amp; 😀 &amp;bogus; &quot;',
    );
    expect(telegramHtmlText('<b>a &lt; b</b>')).toBe('a < b');
    expect(escapeTelegramHtml('<"&>')).toBe('&lt;&quot;&amp;&gt;');
  });

  test('the tree renders back to itself, and a sanitized text is a fixed point', () => {
    const cases = [
      '<b>x <i>y</i></b> &amp; <a href="https://x.test/?q=&quot;">z</a>',
      '<pre><code class="language-ts">a &lt; b</code></pre>',
    ];
    for (const markup of cases) {
      expect(renderTelegramHtml(parseTelegramHtml(markup))).toBe(markup);
      expect(sanitizeTelegramHtml(sanitizeTelegramHtml(markup))).toBe(
        sanitizeTelegramHtml(markup),
      );
    }
  });
});

describe('telegram html: cutting to the limit', () => {
  test('the limit counts what the reader sees, not the markup', () => {
    // 4000 visible characters in 8000 characters of markup: one message.
    const markup = '<b>x</b>'.repeat(4_000);
    expect(splitTelegramHtml(markup)).toEqual([sanitizeTelegramHtml(markup)]);
  });

  test('cuts at a paragraph, then a line, then a space; the break itself is not repeated', () => {
    const first = `First ${'word '.repeat(480)}`.trim();
    const second = `Second ${'word '.repeat(480)}`.trim();
    expect(splitTelegramHtml(`${first}\n\n${second}`, { limit: 3_000 })).toEqual([
      first,
      second,
    ]);
    const lines = Array.from({ length: 60 }, (_, row) => `Line ${row} ${'x'.repeat(120)}`);
    const parts = splitTelegramHtml(lines.join('\n'));
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.flatMap((part) => part.split('\n'))).toEqual(lines);
    const words = splitTelegramHtml('alpha beta gamma delta', { limit: 11 });
    expect(words).toEqual(['alpha beta', 'gamma delta']);
  });

  test('an element across a cut is closed and opened again with its attributes', () => {
    const body = `<a href="https://x.test/?a=1"><i>${'thought '.repeat(1_200).trim()}</i></a>`;
    const parts = splitTelegramHtml(`<b>Heading</b>\n${body}\n\n<b>End</b>`);
    expect(parts.length).toBeGreaterThan(2);
    expectAccepted(parts);
    for (const part of parts) {
      expect(telegramHtmlText(part).length).toBeLessThanOrEqual(4_096);
      expect(sanitizeTelegramHtml(part)).toBe(part);
    }
    expect(parts[0]).toBe('<b>Heading</b>');
    const middle = parts.slice(1, -1);
    expect(
      middle.every(
        (part) =>
          part.startsWith('<a href="https://x.test/?a=1"><i>') && part.endsWith('</i></a>'),
      ),
    ).toBe(true);
    const text = parts.map(telegramHtmlText).join(' ');
    expect(text.match(/thought/g)?.length).toBe(1_200);
  });

  test('a cut never splits a surrogate pair or a custom emoji; a caption has its own limit', () => {
    expect(splitTelegramHtml('😀😀😀', { limit: 3 })).toEqual(['😀', '😀', '😀']);
    const emoji = '<tg-emoji emoji-id="1">👍🏽</tg-emoji>';
    const parts = splitTelegramHtml(`ab${emoji}`, { limit: 4 });
    expect(parts).toEqual(['ab', emoji]);
    const caption = splitTelegramHtml('c'.repeat(TELEGRAM_CAPTION_LIMIT + 1), {
      limit: TELEGRAM_CAPTION_LIMIT,
    });
    expect(caption.map((part) => part.length)).toEqual([TELEGRAM_CAPTION_LIMIT, 1]);
  });

  test('a text with nothing visible is no parts', () => {
    expect(splitTelegramHtml('<b></b> <img>')).toEqual([]);
    expect(() => splitTelegramHtml('x', { limit: 1 })).toThrow(RangeError);
  });

  test('truncation keeps the markup valid and the ellipsis inside the limit', () => {
    expect(truncateTelegramHtml('<b>hello world</b> tail', { limit: 8 })).toBe(
      '<b>hello</b>…',
    );
    expect(truncateTelegramHtml('<i>short</i>')).toBe('<i>short</i>');
    // A paragraph break early on does not cost the rest: truncation keeps the most.
    expect(truncateTelegramHtml('a\n\nbb cc dd ee', { limit: 10 })).toBe('a\n\nbb cc…');
    expect(truncateTelegramHtml('one two three', { limit: 11, ellipsis: ' [more]' })).toBe(
      'one [more]',
    );
    const long = truncateTelegramHtml(`<code>${'y'.repeat(5_000)}</code>`);
    expect(telegramHtmlText(long).length).toBe(4_096);
    expectAccepted([long]);
  });
});

describe('telegram html: the strict check', () => {
  test('names the first thing Telegram would refuse, and passes what it accepts', () => {
    expect(checkTelegramHtml('<b>open').problem).toEqual({ kind: 'unclosed-tag' });
    expect(checkTelegramHtml('<b>x</i>').problem).toEqual({ kind: 'unmatched-end-tag' });
    expect(checkTelegramHtml('<p>x</p>').problem).toEqual({
      kind: 'unsupported-tag',
      tag: 'p',
    });
    expect(checkTelegramHtml('a < b').problem).toEqual({ kind: 'bare-character' });
    expect(checkTelegramHtml('&nbsp;').problem).toEqual({ kind: 'bare-character' });
    expect(checkTelegramHtml('<b>fine</b> &amp; &#33;')).toEqual({ text: 'fine & !' });
  });
});
