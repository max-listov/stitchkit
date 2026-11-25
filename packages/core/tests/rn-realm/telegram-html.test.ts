/**
 * `stitchkit/telegram/html` in the React Native 0.88 realm: the browser bundle
 * runs where `URL` is React Native's own (no `URL.canParse`, a constructor that
 * accepts what a WHATWG parser refuses) and gives the same markup Bun gives —
 * links included — so a preview in an app and the message a server sends agree.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  checkTelegramHtml,
  escapeTelegramHtml,
  markdownToTelegramHtml,
  sanitizeTelegramHtml,
} from '../../src/entrypoints/telegram/html';
import { bundleBrowserIife, CORE_SRC, createRnRealm } from './rn-realm';

const bundlePromise = bundleBrowserIife(`
  import * as html from ${JSON.stringify(join(CORE_SRC, 'entrypoints/telegram/html.ts'))};
  globalThis.__tgHtml = html;
`);

async function loadRealm() {
  const realm = createRnRealm();
  realm.evaluate(await bundlePromise, 'telegram-html.js');
  return realm;
}

const HREFS = [
  'https://example.com',
  'https://example.com/#frag',
  'HTTPS://EXAMPLE.COM/a?b=1&c=2',
  'https://user@example.com:8080/p',
  'https:example.com',
  'https://[::1]/',
  'tg://resolve?domain=x',
  'tg:resolve?domain=x#a',
  'mailto:x@example.com',
  'https://',
  'https://exa<mple.com',
  'https://[::1',
  'https://example.com:70000',
  'https://example.com/a b',
  'https://example.com/a\tb',
  'tg:',
  'javascript:alert(1)',
  'not-a-url',
];

describe('RN 0.88 realm — stitchkit/telegram/html', () => {
  test('the realm URL accepts what Bun refuses: a validator built on URL would differ here', async () => {
    const realm = await loadRealm();
    expect(realm.evaluate<string>('typeof URL.canParse')).toBe('undefined');
    expect(realm.evaluate<string>("new URL('https://').protocol")).toBe('https:');
    expect(URL.canParse('https://')).toBe(false);
  });

  test('links convert and sanitize to the same markup as in Bun', async () => {
    const realm = await loadRealm();
    for (const href of HREFS) {
      const markdown = `[docs](<${href}>)`;
      const markup = `<a href="${href.replaceAll('&', '&amp;').replaceAll('<', '&lt;')}">docs</a>`;
      const fromMarkdown = realm.evaluate<string>(
        `__tgHtml.markdownToTelegramHtml(${JSON.stringify(markdown)})`,
      );
      const sanitized = realm.evaluate<string>(
        `__tgHtml.sanitizeTelegramHtml(${JSON.stringify(markup)})`,
      );
      expect({ href, out: fromMarkdown }).toEqual({
        href,
        out: markdownToTelegramHtml(markdown),
      });
      expect({ href, out: sanitized }).toEqual({ href, out: sanitizeTelegramHtml(markup) });
      expect(sanitizeTelegramHtml(fromMarkdown)).toBe(fromMarkdown);
      expect(checkTelegramHtml(fromMarkdown).problem).toBeUndefined();
    }
    expect(realm.errors).toEqual([]);
  });

  test('which links stay links is decided the same way in both realms', async () => {
    const realm = await loadRealm();
    const kept = (out: string): boolean => out.startsWith('<a ');
    const verdicts = HREFS.map((href) => [
      href,
      kept(
        realm.evaluate<string>(
          `__tgHtml.markdownToTelegramHtml(${JSON.stringify(`[a](<${href}>)`)})`,
        ),
      ),
    ]);
    expect(Object.fromEntries(verdicts)).toEqual({
      'https://example.com': true,
      'https://example.com/#frag': true,
      'HTTPS://EXAMPLE.COM/a?b=1&c=2': true,
      'https://user@example.com:8080/p': true,
      'https:example.com': true,
      'https://[::1]/': true,
      'tg://resolve?domain=x': true,
      'tg:resolve?domain=x#a': true,
      'mailto:x@example.com': true,
      'https://': false,
      'https://exa<mple.com': false,
      'https://[::1': false,
      'https://example.com:70000': false,
      'https://example.com/a b': false,
      'https://example.com/a\tb': false,
      'tg:': false,
      'javascript:alert(1)': false,
      'not-a-url': false,
    });
    // A refused link is its own source text in both realms: visible, escaped, not a link.
    for (const [href, keptAsLink] of verdicts) {
      if (keptAsLink) continue;
      const source = `[a](<${href}>)`;
      expect({ href, out: markdownToTelegramHtml(source) }).toEqual({
        href,
        out: escapeTelegramHtml(source),
      });
    }
  });

  test('mixed documents convert identically in both realms', async () => {
    const realm = await loadRealm();
    const pool = [
      '**bold** [a](https://x.test/(p)) `code`',
      '> quote [b](tg://user?id=1)',
      '| a | b |\n|---|---|\n| [c](mailto:c@x.test) | 2 |',
      '<details><summary>More</summary>\n[d](https://[::1)\n</details>',
      '- [ ] [e](https://exa<mple.com) <u>u</u>',
      '```ts\nconst a = 1;\n```',
    ];
    let seed = 7;
    const next = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) >>> 0;
      return seed / 2 ** 32;
    };
    for (let k = 0; k < 200; k += 1) {
      const lines = Array.from({ length: 1 + Math.floor(next() * 6) }, () => {
        return pool[Math.floor(next() * pool.length)] ?? '';
      });
      const source = lines.join('\n');
      const rn = realm.evaluate<string>(
        `__tgHtml.markdownToTelegramHtml(${JSON.stringify(source)})`,
      );
      expect(rn).toBe(markdownToTelegramHtml(source));
    }
  });
});
