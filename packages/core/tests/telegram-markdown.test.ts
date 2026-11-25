/**
 * `stitchkit/telegram/html`: Markdown-to-Telegram-HTML conversion and
 * fence-aware Markdown splitting.
 */
import { describe, expect, test } from 'bun:test';
import {
  checkTelegramHtml,
  markdownToTelegramHtml,
  sanitizeTelegramHtml,
  splitTelegramHtml,
  splitTelegramMarkdown,
  TELEGRAM_CAPTION_LIMIT,
  TELEGRAM_TEXT_LIMIT,
  TelegramMarkdownSplitError,
  telegramHtmlText,
} from '../src/entrypoints/telegram/html';

/** Every converter output must pass the strict Telegram check and be a sanitizer fixed point. */
function convertAndAssertInvariants(source: string): string {
  const out = markdownToTelegramHtml(source);
  expect(checkTelegramHtml(out).problem).toBeUndefined();
  expect(sanitizeTelegramHtml(out)).toBe(out);
  return out;
}

function createPrng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

describe('telegram markdown: inline formatting', () => {
  test('converts bold, italic, strikethrough, spoiler, underline and nested styles', () => {
    expect(convertAndAssertInvariants('**bold** __also__ *it* _em_')).toBe(
      '<b>bold</b> <b>also</b> <i>it</i> <i>em</i>',
    );
    expect(convertAndAssertInvariants('~~gone~~ ||secret|| <u>under</u> <U>caps</U>')).toBe(
      '<s>gone</s> <tg-spoiler>secret</tg-spoiler> <u>under</u> <u>caps</u>',
    );
    expect(convertAndAssertInvariants('***both*** ___also___')).toBe(
      '<b><i>both</i></b> <b><i>also</i></b>',
    );
    expect(convertAndAssertInvariants('**bold *italic*** and *italic **bold***')).toBe(
      '<b>bold <i>italic</i></b> and <i>italic <b>bold</b></i>',
    );
    expect(convertAndAssertInvariants('**bold _inner_ tail** ~~**both**~~')).toBe(
      '<b>bold <i>inner</i> tail</b> <s><b>both</b></s>',
    );
    expect(convertAndAssertInvariants('||*hidden* and **secret**||')).toBe(
      '<tg-spoiler><i>hidden</i> and <b>secret</b></tg-spoiler>',
    );
    expect(convertAndAssertInvariants('**a** **b** and _c_ _d_ and <u>e <u>f</u> g</u>')).toBe(
      '<b>a</b> <b>b</b> and <i>c</i> <i>d</i> and <u>e f g</u>',
    );
  });

  test('respects Unicode word boundaries for underscores and ignores spaced or empty markers', () => {
    const cyrillicWord =
      '\u043f\u0440\u0438\u0432\u0435\u0442_\u043c\u0438\u0440_\u0442\u0443\u0442';
    const astralWord = '\u{1D400}_\u{1D401}_\u{1D402}';
    expect(convertAndAssertInvariants('foo_bar_baz foo__bar__baz')).toBe(
      'foo_bar_baz foo__bar__baz',
    );
    expect(convertAndAssertInvariants('café_naïve_résumé αβγ_δεζ_ηθι')).toBe(
      'café_naïve_résumé αβγ_δεζ_ηθι',
    );
    expect(convertAndAssertInvariants(cyrillicWord)).toBe(cyrillicWord);
    expect(convertAndAssertInvariants(astralWord)).toBe(astralWord);
    expect(convertAndAssertInvariants('(_italic_) and "_quoted_"')).toBe(
      '(<i>italic</i>) and &quot;<i>quoted</i>&quot;',
    );
    expect(convertAndAssertInvariants('2 * 3 * 4 and a || b || c and a ~~ b ~~ c')).toBe(
      '2 * 3 * 4 and a || b || c and a ~~ b ~~ c',
    );
    expect(convertAndAssertInvariants('**** ____ ~~~~ |||| <u></u> <u>open')).toBe(
      '**** ____ ~~~~ ||||  &lt;u&gt;open',
    );
    // An unclosed outer `<u>` must not poison later valid `<u>...</u>` spans.
    expect(convertAndAssertInvariants('<u>unclosed <u>real</u>')).toBe(
      '&lt;u&gt;unclosed <u>real</u>',
    );
    expect(convertAndAssertInvariants('<u>a <u>b <u>real</u> <u>tail')).toBe(
      '&lt;u&gt;a &lt;u&gt;b <u>real</u> &lt;u&gt;tail',
    );
    expect(convertAndAssertInvariants('<U>unclosed <u>real</U>')).toBe(
      '&lt;U&gt;unclosed <u>real</u>',
    );
  });

  test('supports CommonMark backslash escapes and single/multi-backtick inline code spans', () => {
    expect(convertAndAssertInvariants('\\*a\\* \\_b\\_ \\#1 \\<c\\> \\[d\\]\\(e\\)')).toBe(
      '*a* _b_ #1 &lt;c&gt; [d](e)',
    );
    expect(convertAndAssertInvariants('*a* **b** `c\\*`')).toBe(
      '<i>a</i> <b>b</b> <code>c\\*</code>',
    );
    expect(convertAndAssertInvariants('``a ` b`` and `` ` `` and ```x `` y```')).toBe(
      '<code>a ` b</code> and <code>`</code> and <code>x `` y</code>',
    );
    expect(convertAndAssertInvariants('`   ` and `a < b & c`')).toBe(
      '<code>   </code> and <code>a &lt; b &amp; c</code>',
    );
    expect(convertAndAssertInvariants('**bold with `unclosed** tick`')).toBe(
      '**bold with <code>unclosed** tick</code>',
    );
    expect(convertAndAssertInvariants('**run `ls -la`**')).toBe(
      '<b>run <code>ls -la</code></b>',
    );
  });

  test('validates link protocols, handles balanced parentheses and rejects hostile URLs', () => {
    expect(
      convertAndAssertInvariants(
        '[TypeScript](https://en.wikipedia.org/wiki/TypeScript_(language))',
      ),
    ).toBe('<a href="https://en.wikipedia.org/wiki/TypeScript_(language)">TypeScript</a>');
    expect(convertAndAssertInvariants('[nested](https://example.com/a(b(c))d "title")')).toBe(
      '<a href="https://example.com/a(b(c))d">nested</a>',
    );
    expect(convertAndAssertInvariants('[angle](<https://example.com/a(b)>)')).toBe(
      '<a href="https://example.com/a(b)">angle</a>',
    );
    expect(
      convertAndAssertInvariants(
        '[http](http://a.test) [tg](tg://user?id=42) [mail](mailto:hi@example.com)',
      ),
    ).toBe(
      '<a href="http://a.test">http</a> <a href="tg://user?id=42">tg</a> <a href="mailto:hi@example.com">mail</a>',
    );
    expect(
      convertAndAssertInvariants(
        '[q1](https://x.test/?a=1&b=2) [q2](https://x.test/?a=1&amp;b=2)',
      ),
    ).toBe(
      '<a href="https://x.test/?a=1&amp;b=2">q1</a> <a href="https://x.test/?a=1&amp;b=2">q2</a>',
    );
    // Hostile and unsupported schemes stay their own source text: visible, escaped, never `<a>`.
    for (const hostile of [
      '[click](javascript:alert(1))',
      '[click](JAVASCRIPT:alert(1))',
      '[click](data:text/html,<script>alert(1)</script>)',
      '[click](vbscript:msgbox(1))',
      '[click](file:///etc/passwd)',
      '[click](java&#x09;script:alert(1))',
      '[click](/relative/path)',
    ]) {
      const out = convertAndAssertInvariants(hostile);
      // An entity in the source reads as its character, as in any other text.
      expect(telegramHtmlText(out)).toBe(hostile.replace('&#x09;', '\t'));
      expect(out).not.toContain('<a');
    }
    // Telegram forbids nested `<a>` and `<code>` inside `<a>`; styles inside `<a>` survive.
    expect(convertAndAssertInvariants('[**bold** and `code`](https://example.com)')).toBe(
      '<a href="https://example.com"><b>bold</b> and code</a>',
    );
    expect(convertAndAssertInvariants('[outer [inner](https://b.test)](https://a.test)')).toBe(
      '<a href="https://a.test">outer inner</a>',
    );
    expect(convertAndAssertInvariants('![diagram](https://example.com/pic.png)')).toBe(
      '<a href="https://example.com/pic.png">diagram</a>',
    );
    expect(convertAndAssertInvariants('![](https://example.com/pic.png)')).toBe('');
  });

  test('keeps a link only when its destination names a host Telegram can open', () => {
    // The same rules run in every realm; `tests/rn-realm/telegram-html.test.ts` proves it in React Native's.
    expect(convertAndAssertInvariants('[docs](https://example.com)')).toBe(
      '<a href="https://example.com">docs</a>',
    );
    expect(convertAndAssertInvariants('[bad](javascript:alert(1))')).toBe(
      '[bad](javascript:alert(1))',
    );
    expect(convertAndAssertInvariants('[bad](not-a-url)')).toBe('[bad](not-a-url)');
    expect(convertAndAssertInvariants('[a](https://) [b](https://[::1) [c](tg:)')).toBe(
      '[a](https://) [b](https://[::1) [c](tg:)',
    );
    expect(convertAndAssertInvariants('[a](<https://x.test/a b>)')).toBe(
      '[a](&lt;https://x.test/a b&gt;)',
    );
  });

  test('preserves valid Telegram HTML entities and escapes disallowed or invalid entities', () => {
    expect(convertAndAssertInvariants('a < b & c > d "q"')).toBe(
      'a &lt; b &amp; c &gt; d &quot;q&quot;',
    );
    expect(convertAndAssertInvariants('&amp; &lt; &gt; &quot; &#33; &#128512; &#x2603;')).toBe(
      '&amp; &lt; &gt; &quot; ! 😀 ☃',
    );
    expect(convertAndAssertInvariants('&#60;script&#62; &lt;b&gt;not bold&lt;/b&gt;')).toBe(
      '&lt;script&gt; &lt;b&gt;not bold&lt;/b&gt;',
    );
    // Disallowed named entities and invalid/control/surrogate numeric refs must be escaped.
    expect(
      convertAndAssertInvariants(
        '&nbsp; &apos; &#0; &#x0; &#1; &#55296; &#xD800; &#xDFFF; &#1114112; &#xFFFE; &bogus;',
      ),
    ).toBe(
      '&amp;nbsp; &amp;apos; &amp;#0; &amp;#x0; &amp;#1; &amp;#55296; &amp;#xD800; &amp;#xDFFF; &amp;#1114112; &amp;#xFFFE; &amp;bogus;',
    );
    expect(convertAndAssertInvariants('\\&amp; and `&amp;`')).toBe(
      '&amp;amp; and <code>&amp;amp;</code>',
    );
    expect(convertAndAssertInvariants('<script>alert(1)</script><img src=x onerror=1>')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;&lt;img src=x onerror=1&gt;',
    );
  });
});

describe('telegram markdown: blocks and rich-fallback constructs', () => {
  test('renders fenced code blocks (backticks and tildes), validates language and falls back on unclosed fences', () => {
    expect(convertAndAssertInvariants('```ts\nconst x = a < b;\n```')).toBe(
      '<pre><code class="language-ts">const x = a &lt; b;</code></pre>',
    );
    expect(convertAndAssertInvariants('```c++ title="main.cpp"\nint main() {}\n```')).toBe(
      '<pre><code class="language-c++">int main() {}</code></pre>',
    );
    expect(convertAndAssertInvariants('~~~\nplain & raw\n~~~')).toBe(
      '<pre>plain &amp; raw</pre>',
    );
    expect(convertAndAssertInvariants('````md\n```ts\nconst x = 1;\n```\n````')).toBe(
      '<pre><code class="language-md">```ts\nconst x = 1;\n```</code></pre>',
    );
    // Language token strictly validated against `^[\w+#.-]{1,64}$`.
    const maxLang = 'a'.repeat(64);
    expect(convertAndAssertInvariants(`\`\`\`${maxLang}\nok\n\`\`\``)).toBe(
      `<pre><code class="language-${maxLang}">ok</code></pre>`,
    );
    expect(convertAndAssertInvariants(`\`\`\`${'a'.repeat(65)}\nok\n\`\`\``)).toBe(
      '<pre>ok</pre>',
    );
    expect(convertAndAssertInvariants('```bad/lang\nok\n```')).toBe('<pre>ok</pre>');
    // Empty fenced block produces no empty `<pre></pre>`.
    expect(convertAndAssertInvariants('```ts\n```')).toBe('');
    // Unclosed fence stays literal plain text (no `<pre>`, no inline formatting inside).
    expect(convertAndAssertInvariants('**before**\n```ts\nconst x = *raw* < 1;')).toBe(
      '<b>before</b>\n```ts\nconst x = *raw* &lt; 1;',
    );
    expect(convertAndAssertInvariants('~~~\nunclosed & *literal*')).toBe(
      '~~~\nunclosed &amp; *literal*',
    );
  });

  test('renders GFM tables inside <pre> with column alignment and escaped pipes', () => {
    const table = [
      '| Name | Score | Tag |',
      '| :--- | ---: | :---: |',
      '| Alice | 100 | a\\|b |',
      '| Bob | 7 | <x> |',
    ].join('\n');
    expect(convertAndAssertInvariants(table)).toBe(
      '<pre>Name  | Score | Tag\n------+-------+----\nAlice |   100 | a|b\nBob   |     7 | &lt;x&gt;</pre>',
    );
    expect(convertAndAssertInvariants('plain | pipe without separator')).toBe(
      'plain | pipe without separator',
    );
    // Block starters and mismatched column counts do not start a GFM table.
    expect(convertAndAssertInvariants('# Title | Sub\n--- | ---')).toBe(
      '<b>Title | Sub</b>\n--- | ---',
    );
    expect(convertAndAssertInvariants('> a | b\n--- | ---')).toBe(
      '<blockquote>a | b</blockquote>\n--- | ---',
    );
    expect(convertAndAssertInvariants('- a | b\n--- | ---')).toBe('• a | b\n--- | ---');
    expect(convertAndAssertInvariants('1. a | b\n--- | ---')).toBe('1. a | b\n--- | ---');
    expect(convertAndAssertInvariants('a | b | c\n--- | ---')).toBe('a | b | c\n--- | ---');
    expect(convertAndAssertInvariants('a | b\n--- | --- | ---')).toBe(
      'a | b\n--- | --- | ---',
    );
    expect(convertAndAssertInvariants('a \\| b | c\n--- | ---\n1 | 2')).toBe(
      '<pre>a | b | c\n------+--\n1     | 2</pre>',
    );
    expect(convertAndAssertInvariants('> a | b\n> --- | ---\n> 1 | 2')).toBe(
      '<blockquote><pre>a | b\n--+--\n1 | 2</pre></blockquote>',
    );
  });

  test('renders blockquotes with inline formatting, code, links and pre while flattening nested quotes', () => {
    const quote = [
      '> **Note:** check `foo` and [docs](https://example.com)',
      '> > nested **line**',
    ].join('\n');
    expect(convertAndAssertInvariants(quote)).toBe(
      '<blockquote><b>Note:</b> check <code>foo</code> and <a href="https://example.com">docs</a>\nnested <b>line</b></blockquote>',
    );
    expect(convertAndAssertInvariants('> ```ts\n> const n = 1;\n> ```')).toBe(
      '<blockquote><pre><code class="language-ts">const n = 1;</code></pre></blockquote>',
    );
    expect(convertAndAssertInvariants('> \n> <u></u>')).toBe('');
  });

  test('renders headings, nested lists, checkboxes, horizontal rules and details/summary', () => {
    const doc = [
      '# **Main** Heading ##',
      '###### Sub `code`',
      '',
      '- item one',
      '  - nested *item*',
      '    1. ordered child',
      '- [ ] open task',
      '  - [x] done task',
      '  - [X] also done',
      '---',
      '* * *',
    ].join('\n');
    expect(convertAndAssertInvariants(doc)).toBe(
      [
        '<b>Main Heading</b>',
        '<b>Sub <code>code</code></b>',
        '',
        '• item one',
        '  • nested <i>item</i>',
        '    1. ordered child',
        '☐ open task',
        '  ☑ done task',
        '  ☑ also done',
        '───',
        '───',
      ].join('\n'),
    );

    const details = [
      '<details open>',
      '<summary>Build *logs*</summary>',
      '',
      '```html',
      '<details></details>',
      '```',
      '- done',
      '</details>',
    ].join('\n');
    expect(convertAndAssertInvariants(details)).toBe(
      '<b>Build <i>logs</i></b>\n\n<pre><code class="language-html">&lt;details&gt;&lt;/details&gt;</code></pre>\n• done',
    );
    expect(convertAndAssertInvariants('<details><summary>Title</summary>Body</details>')).toBe(
      '<b>Title</b>\nBody',
    );
    expect(convertAndAssertInvariants('<details></details>')).toBe('');
    // `<summary>` inside a fenced code block is literal code, never extracted as the details title.
    const fakeSummary = [
      '<details>',
      '```html',
      '<summary>Fake inside code</summary>',
      '```',
      '</details>',
    ].join('\n');
    expect(convertAndAssertInvariants(fakeSummary)).toBe(
      '<pre><code class="language-html">&lt;summary&gt;Fake inside code&lt;/summary&gt;</code></pre>',
    );
    const fakeBeforeRealSummary = [
      '<details>',
      '```html',
      '<summary>Fake inside code</summary>',
      '```',
      '<summary>Real *title*</summary>',
      'Body',
      '</details>',
    ].join('\n');
    expect(convertAndAssertInvariants(fakeBeforeRealSummary)).toBe(
      '<b>Real <i>title</i></b>\n<pre><code class="language-html">&lt;summary&gt;Fake inside code&lt;/summary&gt;</code></pre>\n\nBody',
    );
    const unclosedSummaryBeforeFence = [
      '<details>',
      '<summary>open',
      '```html',
      '</summary>',
      '```',
      '</details>',
    ].join('\n');
    expect(convertAndAssertInvariants(unclosedSummaryBeforeFence)).toBe(
      '&lt;summary&gt;open\n<pre><code class="language-html">&lt;/summary&gt;</code></pre>',
    );
    expect(convertAndAssertInvariants('')).toBe('');
    expect(convertAndAssertInvariants('line1\r\nline2\rline3')).toBe('line1\nline2\nline3');
  });

  test('details preserves authored paragraph breaks around its body', () => {
    const convert = convertAndAssertInvariants;
    expect(convert('<details>\n<summary>Заголовок</summary>\n\nвнутри\n\n</details>')).toBe(
      '<b>Заголовок</b>\n\nвнутри\n',
    );
    expect(convert('<details>\r\n  <summary>Title</summary>  \r\nBody\r\n  </details>')).toBe(
      '<b>Title</b>\nBody',
    );
    expect(convert('<details>\n\nBody\n\n</details>')).toBe('\nBody\n');
    expect(convert('<details><summary>Title</summary>\n\n\nBody\n\n\n</details>')).toBe(
      '<b>Title</b>\n\n\nBody\n\n',
    );
    expect(convert('<details>\n<summary>Title</summary>\n \n\n</details>')).toBe(
      '<b>Title</b>',
    );
  });

  test('falls back to inline text when <details> is unclosed', () => {
    expect(convertAndAssertInvariants('Intro\n<details> is a tag\n**important**')).toBe(
      'Intro\n&lt;details&gt; is a tag\n<b>important</b>',
    );
    expect(
      convertAndAssertInvariants('<details>\n<details><summary>Real</summary>Body</details>'),
    ).toBe('&lt;details&gt;\n<b>Real</b>\nBody');
    expect(convertAndAssertInvariants('<details>\n```html\n</details>')).toBe(
      '&lt;details&gt;\n```html\n&lt;/details&gt;',
    );
  });
});

describe('telegram markdown: fuzzing invariants', () => {
  test('satisfies checkTelegramHtml and sanitizeTelegramHtml fixed-point on 4,500 adversarial fuzz inputs', () => {
    const rand = createPrng(0x5717c4);
    const tokens = [
      '**',
      '__',
      '***',
      '___',
      '*',
      '_',
      '~~',
      '||',
      '`',
      '``',
      '```',
      '```ts\n',
      '~~~py\n',
      '~~~~\n',
      '````\n',
      '> ',
      '> > ',
      '# ',
      '### ',
      '- ',
      '  - ',
      '1. ',
      '- [ ] ',
      '- [x] ',
      '---\n',
      '[',
      ']',
      '![',
      '(',
      ')',
      '<',
      '>',
      '&',
      '&amp;',
      '&lt;',
      '&gt;',
      '&quot;',
      '&nbsp;',
      '&apos;',
      '&#0;',
      '&#1;',
      '&#55296;',
      '&#xD800;',
      '&#128512;',
      '&#xFFFE;',
      '<u>',
      '</u>',
      '<details>\n',
      '<summary>',
      '</summary>\n',
      '</details>\n',
      '<script>',
      'javascript:alert(1)',
      'data:text/html,hi',
      'https://x.test/a(b)?x=1&y=2',
      'tg://user?id=7',
      'mailto:a@b.test',
      ' | ',
      '\n| --- | ---: |\n',
      '\\',
      '\\*',
      '\\_',
      '\n',
      '\r\n',
      ' ',
      'word',
      'foo_bar_baz',
      'café_naïve',
      'αβγ_δεζ',
      '\u043f\u0440\u0438\u0432\u0435\u0442_\u043c\u0438\u0440',
      '😀',
    ];

    const totalCases = 4_500;
    for (let i = 0; i < totalCases; i += 1) {
      const length = 1 + Math.floor(rand() * 28);
      let input = '';
      for (let j = 0; j < length; j += 1) {
        input += tokens[Math.floor(rand() * tokens.length)] ?? '';
      }
      const out = markdownToTelegramHtml(input);
      const checked = checkTelegramHtml(out);
      if (checked.problem !== undefined) {
        throw new Error(
          `fuzz #${i} failed checkTelegramHtml (${checked.problem.kind}): input=${JSON.stringify(input)} out=${JSON.stringify(out)}`,
        );
      }
      const sanitized = sanitizeTelegramHtml(out);
      if (sanitized !== out) {
        throw new Error(
          `fuzz #${i} failed sanitizeTelegramHtml fixed point: input=${JSON.stringify(input)} out=${JSON.stringify(out)} sanitized=${JSON.stringify(sanitized)}`,
        );
      }
    }
    expect(totalCases).toBe(4_500);
  });
});

/** A table whose aligned form is wider than its Markdown: one wide cell per column, on different rows. */
function staggeredTable(rows: number): string {
  const lines = ['| a | b | c | d |', '|---|---|---|---|'];
  for (let i = 0; i < rows; i += 1) {
    const cells = ['', '', '', ''];
    cells[i % 4] = 'x'.repeat(20);
    lines.push(`|${cells.map((cell) => (cell ? ` ${cell} ` : ' ')).join('|')}|`);
  }
  return lines.join('\n');
}

describe('telegram markdown: delivering as Telegram HTML', () => {
  test('convert, then split the HTML: every part within the limit by what the reader sees', () => {
    const table = staggeredTable(120);
    for (const limit of [TELEGRAM_TEXT_LIMIT, TELEGRAM_CAPTION_LIMIT]) {
      const parts = splitTelegramHtml(markdownToTelegramHtml(table), { limit });
      expect(parts.length).toBeGreaterThan(1);
      for (const part of parts) {
        expect(telegramHtmlText(part).length).toBeLessThanOrEqual(limit);
        expect(checkTelegramHtml(part).problem).toBeUndefined();
        expect(part).toStartWith('<pre>');
      }
    }
  });

  test('a Markdown chunk counts its source, so rendering it can outgrow the limit', () => {
    const chunks = splitTelegramMarkdown(staggeredTable(120));
    expect(chunks).toHaveLength(1);
    expect(telegramHtmlText(markdownToTelegramHtml(chunks[0] ?? '')).length).toBeGreaterThan(
      TELEGRAM_TEXT_LIMIT,
    );
  });

  test('fuzzed documents stay within the limit on the convert-then-split path', () => {
    const rand = createPrng(0x4096);
    const pool = [
      staggeredTable(8),
      '**bold** _it_ `code` [link](https://example.com) <u>u</u>',
      '> quote with `code` and ||spoiler||',
      '```ts\nconst a = 1;\nconst b = 2;\n```',
      '<details><summary>More</summary>\nhidden **text**\n</details>',
      '- [x] done\n- [ ] open',
      `# ${'Title '.repeat(20)}`,
      '😀'.repeat(300),
    ];
    for (let i = 0; i < 100; i += 1) {
      const blocks = Array.from({ length: 4 + Math.floor(rand() * 40) }, () => {
        return pool[Math.floor(rand() * pool.length)] ?? '';
      });
      const limit = [TELEGRAM_CAPTION_LIMIT, TELEGRAM_TEXT_LIMIT, 300][i % 3] ?? 300;
      for (const part of splitTelegramHtml(markdownToTelegramHtml(blocks.join('\n\n')), {
        limit,
      })) {
        expect(telegramHtmlText(part).length).toBeLessThanOrEqual(limit);
        expect(checkTelegramHtml(part).problem).toBeUndefined();
      }
    }
  });
});

describe('telegram markdown: splitting', () => {
  test('splitTelegramMarkdown honors default and custom limit options', () => {
    const exactDefault = 'a'.repeat(TELEGRAM_TEXT_LIMIT);
    expect(splitTelegramMarkdown(exactDefault)).toEqual([exactDefault]);

    const twoLines = `${'a'.repeat(3_000)}\n${'b'.repeat(2_000)}`;
    const defaultChunks = splitTelegramMarkdown(twoLines);
    expect(defaultChunks).toEqual(['a'.repeat(3_000), 'b'.repeat(2_000)]);

    const captionLines = `${'c'.repeat(700)}\n${'d'.repeat(700)}`;
    const captionChunks = splitTelegramMarkdown(captionLines, {
      limit: TELEGRAM_CAPTION_LIMIT,
    });
    expect(captionChunks).toEqual(['c'.repeat(700), 'd'.repeat(700)]);
    for (const chunk of captionChunks) {
      expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_CAPTION_LIMIT);
    }
  });

  test('closes and reopens fenced code blocks within exact limit without orphan fences', () => {
    const fenced = ['```ts', 'aaaa', 'bbbb', 'cccc', '```'].join('\n');
    // Minimum single-line block length: "```ts\naaaa\n```" = 5 + 1 + 4 + 1 + 3 = 14.
    const exact = splitTelegramMarkdown(fenced, { limit: 14 });
    expect(exact).toEqual(['```ts\naaaa\n```', '```ts\nbbbb\n```', '```ts\ncccc\n```']);
    for (const chunk of exact) {
      expect(chunk.length).toBeLessThanOrEqual(14);
      expect(convertAndAssertInvariants(chunk)).toStartWith('<pre><code class="language-ts">');
    }

    // One character below minimum must refuse with `line-exceeds-limit`.
    let caught: unknown;
    try {
      splitTelegramMarkdown(fenced, { limit: 13 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TelegramMarkdownSplitError);
    if (caught instanceof TelegramMarkdownSplitError) {
      expect(caught.reason).toBe('line-exceeds-limit');
      expect(caught.limit).toBe(13);
      expect(caught.lineLength).toBe(14);
    }

    // Text before a fenced block that cannot fit even 1 code line + closing fence flushes first (no empty orphan fence!).
    const withIntro = ['Intro text', '```ts', 'line1', 'line2', '```'].join('\n');
    const chunks = splitTelegramMarkdown(withIntro, { limit: 20 });
    expect(chunks).toEqual(['Intro text', '```ts\nline1\n```', '```ts\nline2\n```']);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(20);
      expect(chunk).not.toContain('```ts\n```');
    }
  });

  test('handles 4-backtick fences, tilde fences, longer closing fences, CRLF, UTF-16 and unclosed fences', () => {
    const fourTick = ['````md', '```ts', 'const x = 1;', '```', '````'].join('\n');
    const fourChunks = splitTelegramMarkdown(fourTick, { limit: 26 });
    expect(fourChunks).toEqual([
      '````md\n```ts\n````',
      '````md\nconst x = 1;\n````',
      '````md\n```\n````',
    ]);
    for (const chunk of fourChunks) {
      expect(chunk.length).toBeLessThanOrEqual(26);
      convertAndAssertInvariants(chunk);
    }

    const tilde = ['~~~python', 'x = 1', 'y = 2', '~~~'].join('\n');
    const tildeChunks = splitTelegramMarkdown(tilde, { limit: 20 });
    expect(tildeChunks).toEqual(['~~~python\nx = 1\n~~~', '~~~python\ny = 2\n~~~']);
    for (const chunk of tildeChunks) expect(chunk.length).toBeLessThanOrEqual(20);

    // Closing fence wider than opening fence (` ``` ` closed by ` ```` `) never produces an empty orphan chunk.
    const widerClose = ['```', '123456', 'abcdef', '````'].join('\n');
    const widerChunks = splitTelegramMarkdown(widerClose, { limit: 15 });
    expect(widerChunks).toEqual(['```\n123456\n```', '```\nabcdef\n````']);
    for (const chunk of widerChunks) expect(chunk.length).toBeLessThanOrEqual(15);

    // CRLF normalization and blank-line boundary handling.
    expect(splitTelegramMarkdown('alpha\r\n\r\nbeta\r\ngamma', { limit: 10 })).toEqual([
      'alpha',
      'beta\ngamma',
    ]);
    expect(splitTelegramMarkdown('')).toEqual([]);
    expect(splitTelegramMarkdown('   \r\n\n  ')).toEqual([]);

    // UTF-16 code units: each emoji is 2 UTF-16 code units.
    expect(splitTelegramMarkdown('😀😀\n😀😀', { limit: 4 })).toEqual(['😀😀', '😀😀']);
    expect(splitTelegramMarkdown('a\nb', { limit: 1 })).toEqual(['a', 'b']);

    // Unclosed fence is plain text: never synthesizes fake closing fences, even for later closed fences.
    const unclosed = ['```ts', 'line1', 'line2'].join('\n');
    expect(splitTelegramMarkdown(unclosed, { limit: 8 })).toEqual(['```ts', 'line1', 'line2']);

    const unclosedWithTilde = ['```ts', 'line1', '~~~py', 'code1', 'code2', '~~~'].join('\n');
    const unclosedChunks = splitTelegramMarkdown(unclosedWithTilde, { limit: 16 });
    expect(unclosedChunks).toEqual(['```ts\nline1', '~~~py\ncode1', 'code2\n~~~']);
    for (const chunk of unclosedChunks) {
      expect(chunk.length).toBeLessThanOrEqual(16);
      convertAndAssertInvariants(chunk);
    }

    const closedThenUnclosed = [
      '```ts',
      'aaaa',
      'bbbb',
      '```',
      '```md',
      'text',
      '~~~sh',
      'cmd1',
      'cmd2',
      '~~~',
    ].join('\n');
    const mixedChunks = splitTelegramMarkdown(closedThenUnclosed, { limit: 14 });
    expect(mixedChunks).toEqual([
      '```ts\naaaa\n```',
      '```ts\nbbbb\n```',
      '```md\ntext',
      '~~~sh\ncmd1',
      'cmd2\n~~~',
    ]);
    for (const chunk of mixedChunks) {
      expect(chunk.length).toBeLessThanOrEqual(14);
      convertAndAssertInvariants(chunk);
    }
  });

  test('repeats a table header in every chunk a table is split across', () => {
    const table = staggeredTable(40);
    const [header = '', separator = ''] = table.split('\n');
    const chunks = splitTelegramMarkdown(`Intro\n${table}\nOutro`, { limit: 300 });
    expect(chunks[0]).toStartWith(`Intro\n${header}\n${separator}\n`);
    const tableChunks = chunks.filter((chunk) => chunk.includes('|'));
    expect(tableChunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(300);
    for (const chunk of tableChunks.slice(1)) {
      expect(chunk).toStartWith(`${header}\n${separator}\n`);
      expect(convertAndAssertInvariants(chunk)).toStartWith('<pre>a ');
    }
    expect(chunks.at(-1)).toEndWith('Outro');
    const rows = chunks
      .join('\n')
      .split('\n')
      .filter((line) => line.includes('x'));
    expect(rows).toEqual(table.split('\n').slice(2));

    let caught: unknown;
    try {
      splitTelegramMarkdown(table, { limit: header.length + separator.length + 10 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TelegramMarkdownSplitError);
    if (caught instanceof TelegramMarkdownSplitError) {
      expect(caught.reason).toBe('line-exceeds-limit');
    }
  });

  test('refuses invalid limits and indivisible lines with typed TelegramMarkdownSplitError', () => {
    for (const badLimit of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      let caught: unknown;
      try {
        splitTelegramMarkdown('hello', { limit: badLimit });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(TelegramMarkdownSplitError);
      expect(caught).toBeInstanceOf(Error);
      if (caught instanceof TelegramMarkdownSplitError) {
        expect(caught.reason).toBe('invalid-limit');
        expect(caught.limit).toBe(badLimit);
      }
    }

    let lineErr: unknown;
    try {
      splitTelegramMarkdown('1234567890', { limit: 5 });
    } catch (error) {
      lineErr = error;
    }
    expect(lineErr).toBeInstanceOf(TelegramMarkdownSplitError);
    if (lineErr instanceof TelegramMarkdownSplitError) {
      expect(lineErr.reason).toBe('line-exceeds-limit');
      expect(lineErr.limit).toBe(5);
      expect(lineErr.lineLength).toBe(10);
    }
  });

  test('preserves chunk-length and HTML invariants across 200 fuzzed multi-line Markdown documents', () => {
    const rand = createPrng(0x20261124);
    const linePool = [
      'plain text line',
      '**bold** and _italic_ and `code`',
      '> quoted `snippet` and [link](https://example.com)',
      '- [x] checked item',
      '',
      'short',
      '😀 emoji line',
    ];
    const fenceStyles = [
      ['```ts', '```'],
      ['````md', '````'],
      ['~~~py', '~~~'],
    ] as const;

    for (let i = 0; i < 200; i += 1) {
      const lines: string[] = [];
      const count = 4 + Math.floor(rand() * 14);
      for (let j = 0; j < count; j += 1) {
        if (rand() < 0.25) {
          const [open, close] = fenceStyles[Math.floor(rand() * fenceStyles.length)] ?? [
            '```',
            '```',
          ];
          lines.push(open);
          const codeCount = 1 + Math.floor(rand() * 5);
          for (let k = 0; k < codeCount; k += 1) {
            lines.push(`const v${k} = ${Math.floor(rand() * 100)};`);
          }
          lines.push(close);
        } else {
          lines.push(linePool[Math.floor(rand() * linePool.length)] ?? 'x');
        }
      }
      const limit = 60 + Math.floor(rand() * 80);
      const chunks = splitTelegramMarkdown(lines.join('\n'), { limit });
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(limit);
        expect(chunk.trim().length).toBeGreaterThan(0);
        convertAndAssertInvariants(chunk);
      }
    }
  });
});
