/**
 * Split Markdown source into chunks for a message that carries Markdown itself
 * — Telegram renders each chunk — without breaking a line, a fenced code block
 * or a GFM table.
 *
 * The limit counts the Markdown of each chunk in UTF-16 code units, the fences
 * and table headers it repeats included — not the text a reader sees after
 * rendering, which can be longer (a table aligned in `<pre>` grows by its
 * padding). For Telegram HTML, convert first and cut the HTML with
 * `splitTelegramHtml`, which counts what the reader sees. A fenced block split
 * across chunks is closed in one and reopened in the next; a table split
 * across chunks repeats its header row and separator. A line that cannot fit
 * even in a fresh chunk, together with the fence or header repeated before it,
 * is refused with `TelegramMarkdownSplitError` rather than cut mid-line.
 */

import {
  type FenceOpen,
  findClosingFenceIndex,
  isTableStart,
  matchFenceOpen,
  startsOtherBlock,
  tableBodyEnd,
} from './markdown-lines';
import { TELEGRAM_TEXT_LIMIT } from './nodes';

/** Options for splitting Markdown source into Telegram-sized chunks. */
export interface TelegramMarkdownSplitOptions {
  /**
   * Maximum UTF-16 code units of Markdown per chunk, repeated fences and table
   * headers included. Default 4096 (`TELEGRAM_TEXT_LIMIT`).
   */
  readonly limit?: number;
}

/**
 * Why `splitTelegramMarkdown` refused to split a document.
 *
 * - `invalid-limit` — `limit` is not a positive safe integer.
 * - `line-exceeds-limit` — a single line does not fit inside `limit`, together
 *   with the fence markers of a closed fenced block or the header and
 *   separator of a table it belongs to.
 */
export type TelegramMarkdownSplitRefusal = 'line-exceeds-limit' | 'invalid-limit';

/** Error thrown by `splitTelegramMarkdown` when the limit is invalid or a line cannot fit. */
export class TelegramMarkdownSplitError extends Error {
  readonly reason: TelegramMarkdownSplitRefusal;
  readonly limit: number;
  readonly lineLength?: number;

  constructor(
    reason: TelegramMarkdownSplitRefusal,
    details: { readonly limit: number; readonly lineLength?: number },
  ) {
    const detail =
      details.lineLength === undefined
        ? `limit ${details.limit}`
        : `line length ${details.lineLength} exceeds limit ${details.limit}`;
    super(`Telegram markdown split refused (${reason}): ${detail}`);
    this.name = 'TelegramMarkdownSplitError';
    this.reason = reason;
    this.limit = details.limit;
    if (details.lineLength !== undefined) this.lineLength = details.lineLength;
  }
}

interface ActiveFence extends FenceOpen {
  readonly closeIndex: number;
}

/**
 * Split Markdown along line boundaries within `limit` UTF-16 code units of
 * Markdown, closing and reopening fenced code blocks and repeating a table's
 * header across chunks.
 */
export function splitTelegramMarkdown(
  source: string,
  options: TelegramMarkdownSplitOptions = {},
): string[] {
  const limit = options.limit ?? TELEGRAM_TEXT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new TelegramMarkdownSplitError('invalid-limit', { limit });
  }
  const normalized = source.replace(/\r\n?/g, '\n');
  if (normalized.trim() === '') return [];
  if (normalized.length <= limit) return [normalized];

  const lines = normalized.split('\n');
  const chunks: string[] = [];
  let current: string[] = [];
  let currentLength = 0;
  let activeFence: ActiveFence | undefined;
  let inUnclosedFence = false;

  const refuseLine = (lineLength: number): never => {
    throw new TelegramMarkdownSplitError('line-exceeds-limit', { limit, lineLength });
  };

  const pushLine = (line: string): void => {
    currentLength += current.length === 0 ? line.length : 1 + line.length;
    current.push(line);
  };

  const flushOutsideFence = (): void => {
    while (current.length > 0 && current[current.length - 1] === '') current.pop();
    if (current.length > 0) chunks.push(current.join('\n'));
    current = [];
    currentLength = 0;
  };

  const flushInsideFence = (fence: ActiveFence): void => {
    pushLine(fence.closeLine);
    chunks.push(current.join('\n'));
    current = [];
    currentLength = 0;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';

    if (activeFence !== undefined) {
      if (index === activeFence.closeIndex) {
        pushLine(line);
        activeFence = undefined;
        continue;
      }
      const nextIsClose = index + 1 === activeFence.closeIndex;
      const closeReserve =
        1 +
        (nextIsClose
          ? (lines[activeFence.closeIndex]?.length ?? activeFence.closeLine.length)
          : activeFence.closeLine.length);
      if (currentLength + 1 + line.length + closeReserve <= limit) {
        pushLine(line);
        continue;
      }
      flushInsideFence(activeFence);
      const freshLength = activeFence.openLine.length + 1 + line.length + closeReserve;
      if (freshLength > limit) {
        throw new TelegramMarkdownSplitError('line-exceeds-limit', {
          limit,
          lineLength: freshLength,
        });
      }
      pushLine(activeFence.openLine);
      pushLine(line);
      continue;
    }

    if (!inUnclosedFence) {
      const opener = matchFenceOpen(line);
      if (opener !== undefined) {
        const closeIndex = findClosingFenceIndex(lines, index, opener);
        if (closeIndex === -1) {
          inUnclosedFence = true;
        } else {
          if (closeIndex === index + 1) {
            const closeLine = lines[closeIndex] ?? opener.closeLine;
            const blockLength = opener.openLine.length + 1 + closeLine.length;
            if (current.length > 0 && currentLength + 1 + blockLength > limit) {
              flushOutsideFence();
            }
            if (blockLength > limit) {
              throw new TelegramMarkdownSplitError('line-exceeds-limit', {
                limit,
                lineLength: blockLength,
              });
            }
            pushLine(opener.openLine);
            pushLine(closeLine);
            index = closeIndex;
            continue;
          }

          const firstBody = lines[index + 1] ?? '';
          const closeReserve =
            1 +
            (closeIndex === index + 2
              ? (lines[closeIndex]?.length ?? opener.closeLine.length)
              : opener.closeLine.length);
          const minStartLength = opener.openLine.length + 1 + firstBody.length + closeReserve;
          if (current.length > 0 && currentLength + 1 + minStartLength > limit) {
            flushOutsideFence();
          }
          if (minStartLength > limit) {
            throw new TelegramMarkdownSplitError('line-exceeds-limit', {
              limit,
              lineLength: minStartLength,
            });
          }
          pushLine(opener.openLine);
          activeFence = { ...opener, closeIndex };
          continue;
        }
      }
    }

    const separator = lines[index + 1];
    if (
      !inUnclosedFence &&
      separator !== undefined &&
      !startsOtherBlock(line) &&
      isTableStart(line, separator)
    ) {
      const end = tableBodyEnd(lines, index + 2);
      const head = line.length + 1 + separator.length;
      const startRow = end > index + 2 ? (lines[index + 2] ?? '') : undefined;
      const minStart = head + (startRow === undefined ? 0 : 1 + startRow.length);
      if (current.length > 0 && currentLength + 1 + minStart > limit) flushOutsideFence();
      if (minStart > limit) refuseLine(minStart);
      pushLine(line);
      pushLine(separator);
      for (let row = index + 2; row < end; row += 1) {
        const body = lines[row] ?? '';
        if (currentLength + 1 + body.length <= limit) {
          pushLine(body);
          continue;
        }
        flushOutsideFence();
        if (head + 1 + body.length > limit) refuseLine(head + 1 + body.length);
        pushLine(line);
        pushLine(separator);
        pushLine(body);
      }
      index = end - 1;
      continue;
    }

    if (line.length > limit) {
      throw new TelegramMarkdownSplitError('line-exceeds-limit', {
        limit,
        lineLength: line.length,
      });
    }
    if (current.length === 0) {
      if (line === '') continue;
      pushLine(line);
      continue;
    }
    if (currentLength + 1 + line.length <= limit) {
      pushLine(line);
      continue;
    }
    flushOutsideFence();
    if (line !== '') pushLine(line);
  }

  flushOutsideFence();
  return chunks;
}
