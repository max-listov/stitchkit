/**
 * Per-handler state — everything `createHandler` resolves once from its
 * `HandlerConfig` and every request then reads: the logging sinks, the trace-id
 * resolver, the compiled route table. An explicit object, so each request
 * phase names what it depends on instead of closing over one long function.
 */

import type { RuntimeContext } from '../contract/runtime-context';
import { type ClientIpOptions, resolveTraceId } from '../internal/request';
import { resolveLoggingConfig } from './logging';
import { assertCorsConfig } from './middleware/cors';
import { assertJsonBodyLimit } from './request-body';
import { compileRouteTable } from './route-table';
import type { RouteMap } from './router';
import type {
  HandlerConfig,
  LifecycleHooks,
  LoggingConfig,
  MethodDef,
  StitchLogger,
} from './types';

export interface HandlerState<TServer> {
  config: HandlerConfig<TServer>;
  cors: HandlerConfig<TServer>['cors'];
  hooks: HandlerConfig<TServer>['hooks'];
  observability: HandlerConfig<TServer>['observability'];
  /** `null` when logging is off. */
  logConfig: LoggingConfig | null;
  customLogger: StitchLogger | null;
  useDefaultLog: boolean;
  /** `logging.enrich` keys already reported as discarded — once per handler. */
  warnedEnrichKeys: Set<string>;
  /** Report a framework-level problem through the configured sink. */
  warn: (line: string) => void;
  /** The request's trace id, with the custom resolver contained. */
  resolveId: (req: Request, fallback?: string) => string;
  routeMap: RouteMap;
}

/** Matched group policy, global policy, then the framework envelope. */
export type RespondError = (
  err: unknown,
  errCtx?: RuntimeContext,
  endpoint?: MethodDef,
  group?: LifecycleHooks,
) => Promise<Response>;

/** Close the request's timing window: one completion line, one observability row. */
export type CompleteRequest = (
  status: number,
  errorCode?: string,
  outcome?: 'cancelled',
) => void;

/** What one request carries through every phase after its trace id is known. */
export interface RequestState<TServer> {
  req: Request;
  url: URL;
  traceId: string;
  server: TServer | undefined;
  clientIp: ClientIpOptions;
  ipAddress: string | undefined;
  complete: CompleteRequest;
  respondError: RespondError;
}

export function createHandlerState<TServer>(
  config: HandlerConfig<TServer>,
): HandlerState<TServer> {
  const { cors, hooks, logging = false, observability } = config;
  if (cors) assertCorsConfig(cors);
  assertJsonBodyLimit(config.maxJsonBodyBytes, 'HandlerConfig.maxJsonBodyBytes');

  // `true` is shorthand for `{}`: any object turns logging on, and `logger`
  // decides which sink writes it. Throws on a pre-0.28 bare `StitchLogger`.
  const logConfig = resolveLoggingConfig(logging);
  const customLogger: StitchLogger | null = logConfig?.logger ?? null;
  const useDefaultLog = logConfig !== null && !logConfig.logger;

  /**
   * Report a framework-level problem through the configured sink. Guarded: a
   * broken logger must never surface as the outcome of the request it observes.
   */
  const warn = (line: string): void => {
    try {
      if (customLogger) customLogger.warn(line);
      else console.warn(line);
    } catch {
      // A logger must never break the request it observes.
    }
  };

  return {
    config,
    cors,
    hooks,
    observability,
    logConfig,
    customLogger,
    useDefaultLog,
    warnedEnrichKeys: new Set<string>(),
    warn,
    resolveId: createTraceIdResolver(config.traceId, warn),
    routeMap: compileRouteTable(config, warn),
  };
}

/**
 * The request's trace id. A custom resolver is consumer code called before
 * any error handling exists, so it is contained here: `undefined` and a throw
 * both fall back to the framework resolver rather than costing the response.
 * The throw is reported once per handler — silence would lose every
 * correlation id without a word, and one line per request would be noise.
 */
function createTraceIdResolver(
  customTraceId: HandlerConfig['traceId'],
  warn: (line: string) => void,
): (req: Request, fallback?: string) => string {
  let traceResolverBroken = false;
  return (req, fallback) => {
    if (!customTraceId) return fallback ?? resolveTraceId(req);
    try {
      return customTraceId(req) ?? fallback ?? resolveTraceId(req);
    } catch (err) {
      if (!traceResolverBroken) {
        traceResolverBroken = true;
        warn(
          '[stitchkit] `traceId` resolver threw — falling back to the framework resolver. ' +
            'Ids will not match your observability context until it is fixed: ' +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return fallback ?? resolveTraceId(req);
    }
  };
}
