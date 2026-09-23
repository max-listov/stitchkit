/*
 * A reply cut into finished sentences while it is still being written, so a voice can start
 * on the first one instead of waiting for the whole turn.
 *
 * A sentence ends at `. ! ? …` (and any closing quote or bracket after it) followed by
 * whitespace and a capital letter, a digit or an opening mark — or at a blank line between
 * paragraphs. So "3.5", "т. е. так" and "e.g. this" are not cut, and the end of the text is
 * not yet the end of a sentence until the turn is over. Nothing is cut inside a fenced code
 * block: code is not read aloud, and a boundary in the middle of one would split what the
 * caller strips.
 */

const TERMINAL = /[.!?…]/;
const CLOSING = /["»”)]/;
const ENDS_SENTENCE = /[.!?…]+["»”)]*$/;
const OPENER = /^[\p{Lu}\p{N}"«“(—–-]/u;
const NEXT_WORD = /^\s+(\S)/u;

export class SentenceCutter {
  private said = 0;

  /** The sentences finished since the previous call; with `final`, the rest of the turn too. */
  next(text: string, final: boolean): string[] {
    const sentences: string[] = [];
    let start = this.said;
    let fence = fenceFrom(text, this.said);
    for (let index = this.said; index < text.length; index += 1) {
      if (index >= fence.end) fence = fenceFrom(text, index);
      if (index >= fence.start && index < fence.end) continue;
      if (!isBoundary(text, index, start)) continue;
      const sentence = text.slice(start, index + 1).trim();
      if (sentence !== '') sentences.push(sentence);
      start = index + 1;
    }
    this.said = start;
    if (final) {
      const rest = text.slice(start).trim();
      if (rest !== '') sentences.push(rest);
      this.said = text.length;
    }
    return sentences;
  }

  /** Start a new turn. */
  reset(): void {
    this.said = 0;
  }
}

function isBoundary(text: string, index: number, start: number): boolean {
  const char = text[index] ?? '';
  if (char === '\n' && text[index + 1] === '\n') return true;
  if (!TERMINAL.test(char) && !CLOSING.test(char)) return false;
  const following = text[index + 1] ?? '';
  if (TERMINAL.test(following) || CLOSING.test(following)) return false;
  if (!ENDS_SENTENCE.test(text.slice(start, index + 1))) return false;
  const next = text.slice(index + 1, index + 64).match(NEXT_WORD);
  return next !== null && OPENER.test(next[1] ?? '');
}

/** The nearest fenced block at or after `from` as `[start, end)`; an unclosed one runs to the end. */
function fenceFrom(text: string, from: number): { start: number; end: number } {
  const open = text.indexOf('```', from);
  if (open === -1) return { start: text.length, end: text.length };
  const close = text.indexOf('```', open + 3);
  return { start: open, end: close === -1 ? text.length : close + 3 };
}
