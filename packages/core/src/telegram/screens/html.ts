/**
 * Telegram HTML that cannot be assembled by accident.
 *
 * A screen interpolates values it did not write — a bot's username, an
 * owner's title, a count — into markup it did. With plain strings every one of
 * those is a place where a `<` in somebody's name breaks the message Telegram
 * is asked to parse, or quietly changes what it shows. So markup is a type:
 * the `html` tag escapes every interpolated string and inserts only another
 * `TelegramHtml` as markup, and text the application already holds as Telegram
 * HTML — an owner's stored greeting — enters through `html.raw`, the one place
 * that says "trusted" out loud.
 */

import { escapeTelegramHtml } from '../html/render';

/** Only `html`, `html.raw` and `html.join` make markup; this key stays in the module. */
const MINT: unique symbol = Symbol('TelegramHtml');

/** Telegram HTML, parsed by Telegram with `parse_mode: 'HTML'`. Made by `html`. */
export class TelegramHtml {
  readonly #markup: string;

  constructor(mint: typeof MINT, markup: string) {
    if (mint !== MINT) {
      throw new TypeError(
        '[stitchkit] telegram screens: markup is made by html`…`, or html.raw for trusted text.',
      );
    }
    this.#markup = markup;
  }

  /** The markup as Telegram receives it. */
  toString(): string {
    return this.#markup;
  }
}

/** What a screen may put where text goes: plain text, or markup. */
export type TelegramText = string | TelegramHtml;

/** A value `html` accepts between its literal parts. */
export type HtmlValue = string | number | bigint | TelegramHtml | false | null | undefined;

function markupOf(value: HtmlValue): string {
  if (value instanceof TelegramHtml) return value.toString();
  if (value === false || value === null || value === undefined) return '';
  return escapeTelegramHtml(String(value));
}

export interface HtmlTag {
  /** Markup with every interpolated value escaped; a nested `html` stays markup. */
  (literals: TemplateStringsArray, ...values: readonly HtmlValue[]): TelegramHtml;
  /** Markup the application already holds, trusted as it is. */
  raw(markup: string): TelegramHtml;
  /** Several fragments as one, separated by `separator` (escaped unless it is markup). */
  join(parts: readonly HtmlValue[], separator?: string | TelegramHtml): TelegramHtml;
}

function tag(literals: TemplateStringsArray, ...values: readonly HtmlValue[]): TelegramHtml {
  let markup = literals[0] ?? '';
  for (const [index, value] of values.entries()) {
    markup += markupOf(value) + (literals[index + 1] ?? '');
  }
  return new TelegramHtml(MINT, markup);
}

export const html: HtmlTag = Object.assign(tag, {
  raw: (markup: string): TelegramHtml => new TelegramHtml(MINT, markup),
  join: (parts: readonly HtmlValue[], separator: string | TelegramHtml = ''): TelegramHtml =>
    new TelegramHtml(
      MINT,
      parts
        .map(markupOf)
        .filter((part) => part !== '')
        .join(markupOf(separator)),
    ),
});
