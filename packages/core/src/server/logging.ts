/**
 * Request-logging configuration: resolving the `logging` option into one shape,
 * and assembling the extra fields a completion line carries beyond the
 * framework's own. Kept out of `logger.ts` — that file is the formatter, this
 * one is the policy.
 */
import { isRecord } from '../internal/typed';
import { getRequestContext } from '../observability/context';
import type { LoggingConfig, LogOutcome } from './types';

const LOGGER_METHODS = ['info', 'warn', 'error', 'debug'];

/**
 * A `StitchLogger` handed straight to `logging`, the pre-0.28 shape. Every
 * field of `LoggingConfig` is optional, so such an object is structurally a
 * valid config — TypeScript rejects the common case through weak-type
 * detection, but a logger typed `any`, or one carrying an index signature (a
 * wrapped `pino`), slips through and silently means "a config with no logger".
 * The app would boot having stopped logging. Refuse it loudly instead.
 */
function isBareLogger(value: Record<string, unknown>): boolean {
  if (value.logger !== undefined || value.skip !== undefined || value.enrich !== undefined) {
    return false;
  }
  return LOGGER_METHODS.every((method) => typeof value[method] === 'function');
}

/**
 * Normalise `logging` into either a config or `null` (off). `true` is shorthand
 * for `{}`: any object turns logging on, and `logger` decides which sink writes.
 */
export function resolveLoggingConfig(logging: boolean | LoggingConfig): LoggingConfig | null {
  if (logging === false) return null;
  if (logging === true) return {};
  if (isRecord(logging) && isBareLogger(logging)) {
    throw new Error(
      '[stitchkit] `logging` no longer takes a StitchLogger directly — nest it: ' +
        '`logging: { logger: myLogger }`.',
    );
  }
  return logging;
}

/** Consult the consumer's noise filter. A throw means "do not skip". */
export function shouldSkipLog(config: LoggingConfig, req: Request, url: URL): boolean {
  if (!config.skip) return false;
  try {
    return config.skip(req, url);
  } catch {
    // A filter must never break the request it observes.
    return false;
  }
}

/**
 * The fields a completion line carries beyond the framework's own — the active
 * request context first (free identity: who, which operation, which tenant),
 * then whatever `enrich` returns, which may override it. Both are merged
 * *under* the framework fields by the caller, so neither can corrupt the record.
 *
 * Returns an empty object when no context is active and no `enrich` is set —
 * the cost of observability that was never wired is one `AsyncLocalStorage`
 * lookup.
 */
export function collectExtraLogFields(
  config: LoggingConfig,
  req: Request,
  url: URL,
  outcome: LogOutcome,
): { fields: Record<string, unknown>; enrichKeys: string[] } {
  const fields: Record<string, unknown> = {};
  const enrichKeys: string[] = [];

  const ctx = getRequestContext();
  if (ctx) {
    if (ctx.userId) fields.userId = ctx.userId;
    if (ctx.serviceName) fields.serviceName = ctx.serviceName;
    if (ctx.action) fields.action = ctx.action;
    // Nested, not spread: `dimensions` is an app-defined bag the core attaches
    // no meaning to, and spreading it would let a tenant key named `path`
    // collide with a framework field. `RequestEvent` nests it for the same
    // reason. → ADR 0029.
    if (ctx.dimensions) fields.dimensions = ctx.dimensions;
  }

  if (config.enrich) {
    try {
      const extra = config.enrich(req, url, outcome);
      if (extra) {
        enrichKeys.push(...Object.keys(extra));
        Object.assign(fields, extra);
      }
    } catch {
      // An enricher must never break the request it observes.
    }
  }

  return { fields, enrichKeys };
}
