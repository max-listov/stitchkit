/**
 * Order keys: the place of a thing among its siblings — a block in a document, a row under its
 * parent — as a text compared code unit by code unit, which is how JavaScript compares strings
 * and how `COLLATE "C"` in PostgreSQL and SQLite's default `BINARY` collation sort these
 * characters.
 *
 * Between any two keys there is a third, so a list is never renumbered: a key written once stays.
 * A key is an integer part and an optional fraction. The integer part's first character says how
 * long it is (`a` two characters, `b` three, … `z`; `Z`, `Y`, … `A` for the negative side), the
 * rest of the key are base-62 digits `0-9A-Za-z`, and the fraction never ends in `0`. Adding at an
 * end counts the integer up or down, so appending ten thousand rows keeps keys of a few
 * characters; only inserts into one gap make keys longer.
 *
 * This is the format of the `fractional-indexing` package (CC0, after David Greenspan's
 * "Implementing Fractional Indexing") with its default alphabets, so keys an application already
 * stores with it read here as well-formed and new keys sort among them. Plain JavaScript: it runs
 * in Hermes and in a browser.
 */
import { z } from 'zod';

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
/** Integer heads: `A`–`Z` mark negative integers (longest first), `a`–`z` positive ones. */
const HEADS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const ZERO = '0';
const LAST = 'z';
/** The one integer below which nothing exists: `A` and twenty-six zeros. */
const SMALLEST_INTEGER = `A${ZERO.repeat(HEADS.length / 2)}`;

/** Why an order key was refused: `malformed` key, bounds not in `order`, or the key space `exhausted`. */
export type OrderKeyRefusal = 'malformed' | 'order' | 'exhausted';

/** A key that is not well-formed, bounds that are not strictly ascending, or an end of the key space. */
export class OrderKeyError extends Error {
  readonly reason: OrderKeyRefusal;
  constructor(reason: OrderKeyRefusal, message: string) {
    super(message);
    this.name = 'OrderKeyError';
    this.reason = reason;
  }
}

function digit(character: string): number {
  return DIGITS.indexOf(character);
}

/** How long the integer part that starts with `head` is, or `undefined` for a character that is not a head. */
function integerLength(head: string): number | undefined {
  const index = HEADS.indexOf(head);
  if (head.length !== 1 || index === -1) return undefined;
  const half = HEADS.length / 2;
  return index < half ? half - index + 1 : index - half + 2;
}

/** The integer part of a well-formed key and its fraction. */
function split(key: string): { integer: string; fraction: string } {
  const length = integerLength(key.charAt(0));
  if (length === undefined || length > key.length)
    throw new OrderKeyError('malformed', `"${key}" is not an order key`);
  return { integer: key.slice(0, length), fraction: key.slice(length) };
}

/** Whether `value` is an order key as {@link orderKeyBetween} makes them. */
export function isOrderKey(value: string): boolean {
  const length = integerLength(value.charAt(0));
  if (length === undefined || length > value.length || value === SMALLEST_INTEGER)
    return false;
  for (let index = 1; index < value.length; index += 1)
    if (digit(value.charAt(index)) === -1) return false;
  return value.length === length || !value.endsWith(ZERO);
}

function assertOrderKey(value: string): void {
  if (!isOrderKey(value))
    throw new OrderKeyError('malformed', `"${value}" is not an order key`);
}

/**
 * A fraction strictly between `low` and `high` (`null`: no upper bound). Neither ends in `0`, and
 * `low < high` when `high` is given.
 */
function midpoint(low: string, high: string | null): string {
  if (high !== null) {
    let common = 0;
    while ((low.charAt(common) || ZERO) === high.charAt(common)) common += 1;
    if (common > 0)
      return high.slice(0, common) + midpoint(low.slice(common), high.slice(common));
  }
  const lowDigit = low === '' ? 0 : digit(low.charAt(0));
  const highDigit = high === null ? DIGITS.length : digit(high.charAt(0));
  if (highDigit - lowDigit > 1) return DIGITS.charAt(Math.round((lowDigit + highDigit) / 2));
  if (high !== null && high.length > 1) return high.slice(0, 1);
  return DIGITS.charAt(lowDigit) + midpoint(low.slice(1), null);
}

/** The next integer, or `undefined` past the largest one. */
function increment(integer: string): string | undefined {
  const head = integer.charAt(0);
  let carried = '';
  for (let index = integer.length - 1; index >= 1; index -= 1) {
    const next = digit(integer.charAt(index)) + 1;
    if (next < DIGITS.length)
      return head + integer.slice(1, index) + DIGITS.charAt(next) + carried;
    carried = ZERO + carried;
  }
  const nextHead = HEADS.charAt(HEADS.indexOf(head) + 1);
  if (nextHead === '') return undefined;
  return nextHead + resized(carried, ZERO, head, nextHead);
}

/** The previous integer, or `undefined` below the smallest one. */
function decrement(integer: string): string | undefined {
  const head = integer.charAt(0);
  let borrowed = '';
  for (let index = integer.length - 1; index >= 1; index -= 1) {
    const previous = digit(integer.charAt(index)) - 1;
    if (previous >= 0)
      return head + integer.slice(1, index) + DIGITS.charAt(previous) + borrowed;
    borrowed = LAST + borrowed;
  }
  const headIndex = HEADS.indexOf(head);
  if (headIndex === 0) return undefined;
  const previousHead = HEADS.charAt(headIndex - 1);
  return previousHead + resized(borrowed, LAST, head, previousHead);
}

/** The digit run of `from` fitted to the integer length `to` heads: one longer, one shorter or equal. */
function resized(run: string, fill: string, from: string, to: string): string {
  const delta = (integerLength(to) ?? 0) - (integerLength(from) ?? 0);
  if (delta > 0) return run + fill;
  if (delta < 0) return run.slice(1);
  return run;
}

/**
 * A key strictly between `low` and `high`; `null` is the open end of the list on that side, so
 * `orderKeyBetween(null, null)` is the key of the first thing in an empty list. A bound that is not
 * an order key throws `OrderKeyError` `malformed`; `low >= high` throws `order`.
 */
export function orderKeyBetween(low: string | null, high: string | null): string {
  if (low !== null) assertOrderKey(low);
  if (high !== null) assertOrderKey(high);
  if (low !== null && high !== null && low >= high)
    throw new OrderKeyError(
      'order',
      `No order key between "${low}" and "${high}": the bounds are not in order`,
    );
  if (low === null && high === null) return `a${ZERO}`;
  if (low === null) return below(high ?? '');
  if (high === null) {
    const { integer, fraction } = split(low);
    return increment(integer) ?? integer + midpoint(fraction, null);
  }
  const lower = split(low);
  const upper = split(high);
  if (lower.integer === upper.integer)
    return lower.integer + midpoint(lower.fraction, upper.fraction);
  const next = increment(lower.integer);
  if (next === undefined)
    throw new OrderKeyError('exhausted', 'No integer after the largest key');
  return next < high ? next : lower.integer + midpoint(lower.fraction, null);
}

/** A key before `high`, with nothing below it given. */
function below(high: string): string {
  const { integer, fraction } = split(high);
  if (integer === SMALLEST_INTEGER) return integer + midpoint('', fraction);
  if (integer < high) return integer;
  const previous = decrement(integer);
  if (previous === undefined)
    throw new OrderKeyError('exhausted', 'No integer before the smallest key');
  // The smallest integer alone is not a key (nothing could go before it), so the key below the
  // next one up carries a fraction. `fractional-indexing` returns the bare integer here and then
  // refuses it as a bound.
  return previous === SMALLEST_INTEGER ? previous + midpoint('', null) : previous;
}

/** An order key at a boundary — a row's position as stored and sent. */
export const OrderKeySchema = z.string().refine(isOrderKey, { error: 'Not an order key' });
