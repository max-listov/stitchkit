import { z } from 'zod';
import { DecimalInputSchema } from '../primitives/decimal';
import { type Money, moneyToDecimal } from '../primitives/money';
import type { XlsxColumn } from './schema';

/** Digits a double keeps. Past this Excel shows a different number than was written. */
const EXCEL_DIGITS = 15;
const MAX_TEXT = 32_767;
const MS_PER_DAY = 86_400_000;
/** Excel's day zero, as a Unix day: day 1 is 1900-01-01, counting a leap day that never was. */
const EXCEL_EPOCH_DAY = -25_569;
const FIRST_RELIABLE_DAY = Date.UTC(1900, 2, 1) / MS_PER_DAY;
const LAST_DAY = Date.UTC(9999, 11, 31) / MS_PER_DAY;
const InstantSchema = z.iso.datetime({ offset: true });

export class XlsxCellError extends TypeError {
  override readonly name = 'XlsxCellError';
}

/** What goes into `<c>`: a number as written, a flag, or text. */
export type XlsxCell =
  | { readonly kind: 'number'; readonly value: string }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'text'; readonly value: string };

function refuse(where: string, expected: string): never {
  throw new XlsxCellError(`${where}: expected ${expected}`);
}

function exactNumber(value: string, where: string): string {
  const digits = value.replace(/^-|\./g, '').replace(/^0+/, '').replace(/0+$/, '');
  if (digits.length > EXCEL_DIGITS) {
    throw new XlsxCellError(
      `${where}: ${value} has more significant digits than Excel keeps (${EXCEL_DIGITS})`,
    );
  }
  const stored = Number(value);
  if (!Number.isFinite(stored) || (stored === 0 && digits !== '')) {
    throw new XlsxCellError(`${where}: ${value} is outside what Excel can hold`);
  }
  return value;
}

function numberCell(value: unknown, where: string): XlsxCell {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) refuse(where, 'a finite number');
    return { kind: 'number', value: String(value) };
  }
  const text = typeof value === 'bigint' ? value.toString() : value;
  const parsed = DecimalInputSchema.safeParse(text);
  if (!parsed.success) refuse(where, 'a number or a decimal string');
  return { kind: 'number', value: exactNumber(parsed.data, where) };
}

function isMoney(value: unknown): value is Money {
  return (
    typeof value === 'object' &&
    value !== null &&
    /^-?(?:0|[1-9]\d*)$/.test(String(Reflect.get(value, 'minor'))) &&
    typeof Reflect.get(value, 'minor') === 'string' &&
    typeof Reflect.get(value, 'currency') === 'string'
  );
}

function moneyCell(
  value: unknown,
  column: Extract<XlsxColumn, { type: 'money' }>,
  where: string,
): XlsxCell {
  if (!isMoney(value)) return refuse(where, `Money in ${column.currency}`);
  if (value.currency !== column.currency) {
    return refuse(where, `Money in ${column.currency}, not ${value.currency}`);
  }
  return {
    kind: 'number',
    value: exactNumber(moneyToDecimal(value, column.scale), where),
  };
}

function dateCell(value: unknown, where: string): XlsxCell {
  const match = typeof value === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
  if (!match) return refuse(where, 'a date as YYYY-MM-DD');
  const [, year, month, day] = match;
  const time = Date.UTC(Number(year), Number(month) - 1, Number(day));
  if (new Date(time).toISOString().slice(0, 10) !== value) {
    return refuse(where, 'a calendar date that exists');
  }
  const unixDay = time / MS_PER_DAY;
  if (unixDay < FIRST_RELIABLE_DAY) return refuse(where, 'a date from 1900-03-01');
  return { kind: 'number', value: String(unixDay - EXCEL_EPOCH_DAY) };
}

function instantOf(value: unknown): number | undefined {
  if (value instanceof Date) return value.getTime();
  return InstantSchema.safeParse(value).success ? Date.parse(String(value)) : undefined;
}

/** One per zone: building a formatter costs more than using it thousands of times. */
const wallClocks = new Map<string, Intl.DateTimeFormat>();

function wallClockIn(timeZone: string): Intl.DateTimeFormat {
  const known = wallClocks.get(timeZone);
  if (known) return known;
  const created = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  });
  wallClocks.set(timeZone, created);
  return created;
}

function datetimeCell(
  value: unknown,
  column: Extract<XlsxColumn, { type: 'datetime' }>,
  where: string,
): XlsxCell {
  const instant = instantOf(value);
  if (instant === undefined || Number.isNaN(instant)) {
    return refuse(where, 'a Date or an ISO instant with an offset');
  }
  // Bounded before the zone is applied: `Date.UTC` reads a year under 100 as 19xx.
  if (instant / MS_PER_DAY < FIRST_RELIABLE_DAY || instant / MS_PER_DAY >= LAST_DAY) {
    return refuse(where, 'an instant from 1900-03-01 to 9999-12-30');
  }
  const fields = wallClockIn(column.timeZone).formatToParts(instant);
  const field = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(fields.find((part) => part.type === type)?.value);
  const wallClock = Date.UTC(
    field('year'),
    field('month') - 1,
    field('day'),
    field('hour'),
    field('minute'),
    field('second'),
  );
  if (wallClock / MS_PER_DAY < FIRST_RELIABLE_DAY) {
    return refuse(where, 'an instant from 1900-03-01 in its time zone');
  }
  return { kind: 'number', value: String(wallClock / MS_PER_DAY - EXCEL_EPOCH_DAY) };
}

export function cellOf(value: unknown, column: XlsxColumn, where: string): XlsxCell {
  switch (column.type) {
    case 'text':
      if (typeof value !== 'string') return refuse(where, 'text');
      if (value.length > MAX_TEXT) return refuse(where, `at most ${MAX_TEXT} characters`);
      return { kind: 'text', value };
    case 'number':
      return numberCell(value, where);
    case 'money':
      return moneyCell(value, column, where);
    case 'date':
      return dateCell(value, where);
    case 'datetime':
      return datetimeCell(value, column, where);
    case 'boolean':
      if (typeof value !== 'boolean') return refuse(where, 'a boolean');
      return { kind: 'boolean', value };
  }
}
