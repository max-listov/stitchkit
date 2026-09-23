/**
 * Aggregate views over a CLI result.
 *
 * `cli-format` is right that the CLI's audience is agents, scripts and `jq`, and
 * that JSON is the encoding. It does not follow that the answer to "how many per
 * status" is the whole collection: an agent pays for every character of a
 * 98-record listing in its context window, and `| jq` arrives too late — the
 * bytes were read into the conversation before the pipe saw them. A view is
 * computed here, on the result, before anything is written.
 *
 * The flags are reserved CLI behaviour like `--json`, so they never reach a tool
 * argument, and without one the emitted bytes are exactly what they were.
 */
import { isUnsafeKey } from '../../internal/safe-json';
import { isRecord } from '../../internal/typed';
import { CliArgumentError, type CliResultView } from './args';

/** What a view produces: a JSON value, or the one human-facing shape. */
export type CliViewOutput = { kind: 'json'; data: unknown } | { kind: 'text'; text: string };

/** A record that carries no value for the field at all. */
const ABSENT = '(absent)';

/**
 * The collection a view aggregates: the result itself when it is an array, or
 * the single array field of a result object. Anything else is an argument
 * error — an aggregate over a scalar is a question with no answer, and guessing
 * which of two array fields was meant would answer a different one silently.
 */
function selectRecords(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (isRecord(data)) {
    const arrays = Object.entries(data).filter(([, value]) => Array.isArray(value));
    const only = arrays[0];
    if (arrays.length === 1 && only && Array.isArray(only[1])) return only[1];
    if (arrays.length > 1) {
      throw new CliArgumentError(
        `an aggregate needs one collection, but the result carries several: ${arrays
          .map(([key]) => key)
          .join(', ')} — name the shape you want with jq instead`,
      );
    }
  }
  throw new CliArgumentError('an aggregate needs a collection; this result is not one');
}

/** Read a plain or dotted field path out of one record. */
function readField(record: unknown, path: readonly string[]): unknown {
  let current: unknown = record;
  for (const segment of path) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function fieldPath(field: string): string[] {
  const path = field.split('.');
  if (path.some((segment) => segment.length === 0 || isUnsafeKey(segment))) {
    throw new CliArgumentError(`"${field}" is not a readable field path`);
  }
  return path;
}

/** Every key a caller could have meant, for an error that can be acted on. */
function availableFields(records: readonly unknown[]): string[] {
  const keys = new Set<string>();
  for (const record of records) {
    if (isRecord(record)) for (const key of Object.keys(record)) keys.add(key);
  }
  return [...keys].sort();
}

/**
 * Refuse a field no record carries. A group of zero over a misspelled field is
 * indistinguishable from a true empty answer, and the caller reads it as data.
 */
function assertFieldPresent(records: readonly unknown[], field: string): string[] {
  const path = fieldPath(field);
  const present = records.some((record) => readField(record, path) !== undefined);
  if (!present) {
    const available = availableFields(records);
    throw new CliArgumentError(
      `no record carries the field "${field}"${
        available.length > 0 ? ` — available: ${available.join(', ')}` : ''
      }`,
    );
  }
  return path;
}

function groupKey(value: unknown): string {
  if (value === undefined) return ABSENT;
  if (value === null) return 'null';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Descending by amount, then by key, so `--top` takes a defined slice. */
function ordered(
  totals: Map<string, number>,
  top: number | undefined,
): Record<string, number> {
  const entries = [...totals].sort(([leftKey, left], [rightKey, right]) =>
    right === left ? leftKey.localeCompare(rightKey) : right - left,
  );
  const sliced = top === undefined ? entries : entries.slice(0, top);
  return Object.fromEntries(sliced);
}

function numericValue(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  throw new CliArgumentError(`--sum ${field}: "${groupKey(value)}" is not a number`);
}

function renderTable(records: readonly unknown[], fields: readonly string[]): string {
  const paths = fields.map((field) => assertFieldPresent(records, field));
  const cell = (value: unknown): string => {
    if (value === undefined) return '';
    if (value === null) return 'null';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  };
  const rows = records.map((record) => paths.map((path) => cell(readField(record, path))));
  const widths = fields.map((field, column) =>
    Math.max(field.length, ...rows.map((row) => row[column]?.length ?? 0)),
  );
  const line = (cells: readonly string[]): string =>
    cells
      .map((value, column) => value.padEnd(widths[column] ?? value.length))
      .join('  ')
      .trimEnd();
  return `${[line(fields), line(widths.map((width) => '-'.repeat(width))), ...rows.map(line)].join('\n')}\n`;
}

/**
 * Compare two field values for the record order.
 *
 * A record that carries no value for the field sorts last in **both**
 * directions. It is not the smallest — it is not on the scale at all, and
 * letting it lead an ascending list would answer a question nobody asked.
 */
function compareFieldValues(left: unknown, right: unknown): number {
  if (left === undefined || left === null)
    return right === undefined || right === null ? 0 : 1;
  if (right === undefined || right === null) return -1;
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  if (typeof left === 'bigint' || typeof right === 'bigint') {
    return Number(left) - Number(right);
  }
  return groupKey(left).localeCompare(groupKey(right));
}

/**
 * The record view: the records themselves, optionally ordered and cut.
 *
 * `--sort` orders records and `--by` groups them — one word each, so `--top`
 * keeps the single meaning it has everywhere: the n leading entries of the view
 * that was asked for. "The five largest, as a table" is those two composed,
 * which is the question a CLI is actually asked.
 */
function renderRecords(
  records: readonly unknown[],
  view: { sort?: string; ascending?: boolean; top?: number; table?: readonly string[] },
): CliViewOutput {
  let selected = [...records];
  if (view.sort !== undefined) {
    const path = assertFieldPresent(records, view.sort);
    const direction = view.ascending ? 1 : -1;
    selected.sort((left, right) => {
      const order = compareFieldValues(readField(left, path), readField(right, path));
      // An absent value stays last whichever way the scale runs, so it is
      // excluded from the direction flip rather than dragged to the front.
      const absent =
        readField(left, path) === undefined || readField(right, path) === undefined;
      return absent ? order : order * direction;
    });
  }
  if (view.top !== undefined) selected = selected.slice(0, view.top);
  return view.table
    ? { kind: 'text', text: renderTable(selected, view.table) }
    : { kind: 'json', data: selected };
}

/** Compute the requested view, or refuse it with a message naming the field. */
export function renderCliView(data: unknown, view: CliResultView): CliViewOutput {
  const records = selectRecords(data);
  if (view.kind === 'records') return renderRecords(records, view);

  if (view.kind === 'count') {
    const path = assertFieldPresent(records, view.field);
    const totals = new Map<string, number>();
    for (const record of records) {
      const key = groupKey(readField(record, path));
      totals.set(key, (totals.get(key) ?? 0) + 1);
    }
    return { kind: 'json', data: ordered(totals, view.top) };
  }

  const path = assertFieldPresent(records, view.field);
  if (view.by === undefined) {
    let total = 0;
    for (const record of records)
      total += numericValue(readField(record, path), view.field) ?? 0;
    return { kind: 'json', data: total };
  }
  const byPath = assertFieldPresent(records, view.by);
  const totals = new Map<string, number>();
  for (const record of records) {
    const key = groupKey(readField(record, byPath));
    totals.set(
      key,
      (totals.get(key) ?? 0) + (numericValue(readField(record, path), view.field) ?? 0),
    );
  }
  return { kind: 'json', data: ordered(totals, view.top) };
}
