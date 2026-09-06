import { isRecord } from '../internal/typed';
import type { StitchLogger } from '../logger';
import { getRequestContext } from './context';
import { type JsonValue, measureSize, sanitizePayload } from './sanitize';

export const DEFAULT_REDACT_PATHS = Object.freeze([
  '*.password',
  '*.token',
  '*.cookie',
  '*.authorization',
  '*.secret',
  '**.password',
  '**.token',
  '**.cookie',
  '**.authorization',
  '**.secret',
]);

export interface BoundedLoggerBounds {
  readonly stringLength?: number;
  readonly collectionLength?: number;
  readonly depth?: number;
  readonly entryBytes?: number;
}

export interface BoundedLoggerOptions {
  readonly sink: StitchLogger;
  readonly redact?: {
    readonly paths?: readonly string[];
    readonly keys?: RegExp;
  };
  readonly bounds?: BoundedLoggerBounds;
  readonly sensitiveUrlPatterns?: readonly RegExp[];
}

type LogLevel = keyof StitchLogger;

function asLogRecord(value: JsonValue | null): {
  message: string;
  data?: Record<string, unknown>;
} {
  if (isRecord(value)) {
    if (value._truncated === true) {
      return {
        message: '[truncated log entry]',
        data: {
          _truncated: true,
          _originalBytes: value._originalBytes,
          preview: value.preview,
        },
      };
    }
    const message =
      typeof value.message === 'string' ? value.message : '[sanitized log entry]';
    const data = value.data;
    return { message, ...(isRecord(data) ? { data } : {}) };
  }
  return { message: '[truncated log entry]', data: { entry: value } };
}

function byteLength(value: unknown): number {
  return measureSize(value).responseBytes;
}

function fitLogRecord(
  record: { message: string; data?: Record<string, unknown> },
  maxBytes: number,
): { message: string; data?: Record<string, unknown> } {
  let message = record.message;
  let data = record.data ? { ...record.data } : undefined;
  while (byteLength({ message, data }) > maxBytes) {
    if (typeof data?.preview === 'string' && data.preview.length > 0) {
      const points = Array.from(data.preview);
      data.preview =
        points.length <= 1 ? '' : `${points.slice(0, points.length / 2).join('')}…`;
      continue;
    }
    if (message.length > 16) {
      const points = Array.from(message);
      message = `${points.slice(0, points.length / 2).join('')}…`;
      continue;
    }
    data = { _truncated: true };
    message = '[truncated]';
    break;
  }
  return { message, ...(data && { data }) };
}

/** Decorate any canonical logger with context, redaction, and hard bounds. */
export function createBoundedLogger(options: BoundedLoggerOptions): StitchLogger {
  const entryBytes = options.bounds?.entryBytes ?? 65_536;
  if (!Number.isSafeInteger(entryBytes) || entryBytes < 128) {
    throw new TypeError('createBoundedLogger entryBytes must be an integer of at least 128');
  }
  const write = (level: LogLevel, message: string, data?: Record<string, unknown>): void => {
    try {
      const context = getRequestContext();
      const enriched: Record<string, unknown> = {
        ...data,
        ...(context?.trace.traceId !== undefined && { traceId: context.trace.traceId }),
        ...(context?.trace.spanId !== undefined && { spanId: context.trace.spanId }),
        ...(context?.userId !== undefined && { userId: context.userId }),
        ...(context?.dimensions !== undefined && { dimensions: context.dimensions }),
      };
      const value = sanitizePayload(
        { message, data: enriched },
        {
          sensitiveKeys: options.redact?.keys,
          includeDefaultSensitiveKeys: true,
          sensitivePaths: [
            ...DEFAULT_REDACT_PATHS,
            ...(options.redact?.paths ?? []).map((path) => `data.${path}`),
          ],
          sensitiveUrlPatterns: options.sensitiveUrlPatterns,
          maxStringLength: options.bounds?.stringLength ?? 4_000,
          maxCollectionLength: options.bounds?.collectionLength ?? 100,
          maxDepth: options.bounds?.depth ?? 6,
          maxBytes: entryBytes,
        },
      );
      const sanitized = fitLogRecord(asLogRecord(value), entryBytes);
      // A sink typed `void` may still hand back a promise; its rejection must
      // not surface as an unhandled rejection in the application.
      const result: unknown = options.sink[level](sanitized.message, sanitized.data);
      if (result instanceof Promise) result.catch(() => undefined);
    } catch {
      // Logging must never become the application's failure path.
    }
  };
  return {
    info: (message, data) => write('info', message, data),
    warn: (message, data) => write('warn', message, data),
    error: (message, data) => write('error', message, data),
    debug: (message, data) => write('debug', message, data),
  };
}
