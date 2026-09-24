import type { StitchLogger } from '../internal/logger';
import { type BoundedLoggerOptions, createBoundedLogger } from './bounded-logger';

/**
 * A process journal: one JSON object per line on standard output.
 *
 * A long-running process without a request — a bot, a worker — had no journal
 * of its own here, so each one chose: a hand-written ndjson writer that cut the
 * stack, `console.log` strings, or pino, where an error logged under any key but
 * `err` became `"error":{}` and a production startup failure had to be
 * reproduced by hand to learn its cause.
 *
 * The line is pino's shape on purpose — numeric `level`, `time` in epoch
 * milliseconds, `msg` — so a supervisor that already recognises
 * `"level":50` as an error, and `pino-pretty` on a developer's terminal, read
 * it unchanged. What pino does not do, this does: every value passes through
 * `createBoundedLogger`, so an `Error` in *any* field is written with its name,
 * message, stack and cause, secrets are masked, and one line stays bounded.
 */

/** pino's numbers, which is the contract a line reader matches on. */
export const JSON_LOG_LEVELS = { debug: 20, info: 30, warn: 40, error: 50 } as const;
export type JsonLogLevel = keyof typeof JSON_LOG_LEVELS;

export interface JsonLoggerOptions extends Omit<BoundedLoggerOptions, 'sink'> {
  /** The lowest level written. Default `info`. */
  readonly level?: JsonLogLevel;
  /** Fields on every line — the service name, the release. A call's own fields win. */
  readonly fields?: Readonly<Record<string, unknown>>;
  /** Where a finished line goes. Default: standard output, newline-terminated. */
  readonly write?: (line: string) => void;
  /** Default `Date.now`. */
  readonly now?: () => number;
}

function standardOutput(line: string): void {
  process.stdout.write(`${line}\n`);
}

/** Last resort for a value `JSON.stringify` refuses after sanitising — the line is still written. */
function serialise(record: Record<string, unknown>): string {
  try {
    return JSON.stringify(record);
  } catch {
    return JSON.stringify({ level: record.level, time: record.time, msg: record.msg });
  }
}

export function createJsonLogger(options: JsonLoggerOptions = {}): StitchLogger {
  const threshold = JSON_LOG_LEVELS[options.level ?? 'info'];
  const write = options.write ?? standardOutput;
  const now = options.now ?? Date.now;
  const fields = options.fields ?? {};
  const line =
    (level: JsonLogLevel) =>
    (msg: string, data?: Record<string, unknown>): void => {
      // The contract fields lead the line and cannot be overwritten by a
      // call's own `level` or `msg`: a reader matching `"level":50` must not
      // be told otherwise by application data.
      const own = { level: JSON_LOG_LEVELS[level], time: now(), msg };
      write(serialise(Object.assign({ ...own }, data, own)));
    };
  const sink: StitchLogger = {
    debug: line('debug'),
    info: line('info'),
    warn: line('warn'),
    error: line('error'),
  };
  const bounded = createBoundedLogger({ ...options, sink });
  const gated =
    (level: JsonLogLevel) =>
    (msg: string, data?: Record<string, unknown>): void => {
      if (JSON_LOG_LEVELS[level] >= threshold) bounded[level](msg, { ...fields, ...data });
    };
  return {
    debug: gated('debug'),
    info: gated('info'),
    warn: gated('warn'),
    error: gated('error'),
  };
}
