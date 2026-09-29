/**
 * Would Telegram refuse this markup as it stands? The strict counterpart of
 * the lenient parse: no repair, the first thing Telegram would stop at.
 *
 * For markup a person typed and should hear about before it is sent — an
 * editor warning that Telegram will refuse the text — rather than markup to be
 * repaired, which is `sanitizeTelegramHtml`'s. The screens test chat refuses
 * with it, so a bot's test fails where production would.
 */

import { tokenize } from './parse';

/** The tags Telegram's HTML parse mode accepts, as they may be written. */
const TAGS = new Set([
  'b',
  'strong',
  'i',
  'em',
  'u',
  'ins',
  's',
  'strike',
  'del',
  'span',
  'tg-spoiler',
  'a',
  'tg-emoji',
  'tg-time',
  'code',
  'pre',
  'blockquote',
]);

export type TelegramHtmlProblem =
  | { readonly kind: 'bare-character' }
  | { readonly kind: 'unsupported-tag'; readonly tag: string }
  | { readonly kind: 'unmatched-end-tag' }
  | { readonly kind: 'unclosed-tag' };

export interface TelegramHtmlCheck {
  readonly problem?: TelegramHtmlProblem;
  /** The visible text up to the problem, or all of it. */
  readonly text: string;
}

export function checkTelegramHtml(markup: string): TelegramHtmlCheck {
  const open: string[] = [];
  let text = '';
  for (const token of tokenize(markup)) {
    if (token.type === 'text') text += token.text;
    else if (token.type === 'entity') {
      if (!token.telegram) return { problem: { kind: 'bare-character' }, text };
      text += token.text;
    } else if (token.type === 'bare') return { problem: { kind: 'bare-character' }, text };
    else if (!TAGS.has(token.name)) {
      return { problem: { kind: 'unsupported-tag', tag: token.name }, text };
    } else if (!token.closing) open.push(token.name);
    else if (open.pop() !== token.name)
      return { problem: { kind: 'unmatched-end-tag' }, text };
  }
  return open.length > 0 ? { problem: { kind: 'unclosed-tag' }, text } : { text };
}
