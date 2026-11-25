/**
 * A split never loses a custom emoji or a time and never sends an empty part, wherever the atom
 * stands against a cut — in particular when its own text begins with the space or line break a
 * cut would be made at. Random inputs from a fixed seed put atoms at part boundaries; each atom
 * fits the limit, so every input must split.
 */
import { describe, expect, test } from 'bun:test';
import { splitTelegramHtml, telegramHtmlText } from '../src/entrypoints/telegram/html';

/** mulberry32: a small seeded generator, so a failure names an input that can be replayed. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const BREAKS = [' ', '\n', '\n\n', ''];

interface Input {
  readonly markup: string;
  readonly limit: number;
  /** Each atom's markup, which must reach one part whole. */
  readonly atoms: readonly string[];
}

function input(next: () => number): Input {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
  const limit = 3 + Math.floor(next() * 10);
  const atoms: string[] = [];
  let markup = '';
  for (let piece = 0; piece < 3 + Math.floor(next() * 6); piece += 1) {
    if (next() < 0.5) {
      markup += `${'w'.repeat(1 + Math.floor(next() * limit))}${pick(BREAKS)}`;
      continue;
    }
    // An atom whose text starts with a break more often than not, and fits the limit.
    const lead = pick([' ', '\n', '\n\n', 'x']);
    const body = 'y'.repeat(Math.max(1, Math.floor(next() * (limit - lead.length)) + 1));
    const text = `${lead}${body}`.slice(0, limit);
    const atom =
      next() < 0.5
        ? `<tg-emoji emoji-id="${atoms.length + 1}">${text}</tg-emoji>`
        : `<tg-time unix="${1_700_000_000 + atoms.length}">${text}</tg-time>`;
    atoms.push(atom);
    markup += `${pick(BREAKS)}${atom}${pick(BREAKS)}`;
  }
  return { markup, limit, atoms };
}

const visible = (text: string): string => text.replace(/\s+/g, '');

describe('telegram html: atoms across a cut', () => {
  test('the cases found: an atom that begins with a space or a line break', () => {
    for (const [markup, limit] of [
      ['abcd <tg-emoji emoji-id="1"> xy</tg-emoji> tail', 5],
      ['abcd<tg-emoji emoji-id="1">\n\nxy</tg-emoji>tail', 5],
      ['aaaa <tg-time unix="1700000000"> 12 May</tg-time> zz', 7],
    ] as const) {
      const parts = splitTelegramHtml(markup, { limit });
      expect(parts, markup).not.toContain('');
      expect(visible(parts.map(telegramHtmlText).join('')), markup).toBe(
        visible(telegramHtmlText(markup)),
      );
    }
  });

  test('an atom whose whole text is blank is a part of its own, not a blank part dropped', () => {
    const time = '<tg-time unix="1"> </tg-time>';
    expect(splitTelegramHtml(`ab\n\n${time}\n\ncd`, { limit: 3 })).toEqual(['ab', time, 'cd']);
    const emoji = '<tg-emoji emoji-id="1">\n</tg-emoji>';
    expect(splitTelegramHtml(`ab ${emoji} cd`, { limit: 2 })).toEqual(['ab', emoji, 'cd']);
  });

  test('random inputs: no part is empty or over the limit, and every atom reaches one part whole', () => {
    const next = random(20_261_125);
    for (let round = 0; round < 3_000; round += 1) {
      const { markup, limit, atoms } = input(next);
      const parts = splitTelegramHtml(markup, { limit });
      const label = JSON.stringify({ markup, limit, parts });
      for (const part of parts) {
        expect(part, label).not.toBe('');
        expect(telegramHtmlText(part).length, label).toBeLessThanOrEqual(limit);
      }
      for (const atom of atoms)
        expect(parts.filter((part) => part.includes(atom)).length, `${label} ${atom}`).toBe(1);
      expect(visible(parts.map(telegramHtmlText).join('')), label).toBe(
        visible(telegramHtmlText(markup)),
      );
    }
  });
});
