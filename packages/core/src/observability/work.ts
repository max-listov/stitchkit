/**
 * A unit of work that is not a request.
 *
 * An agent loop started fire-and-forget, a scheduled broadcast, a scenario
 * engine tick: each has a beginning, a duration and an outcome, and none of
 * them arrived over a transport. The context they run in was shaped for
 * requests and required `method` and `path`, so work without a transport either
 * invented them — `method: 'AGENT'`, which is not a verb but the absence of one
 * written into the field for verbs — or ran with no context at all, in which
 * case `setRequestDimensions` was a silent no-op and nothing it did was
 * audited.
 *
 * `runUnitOfWork` gives that work the same treatment a request gets: one
 * context, one completion record, written by the same hand into the same sink.
 * What it deliberately does NOT do is fill the transport fields. A job has no
 * verb, no path and no HTTP status, and the honest record of that is their
 * absence — moving the invention from the consumer into the framework would
 * have been the same lie with a better address.
 */
import type { TransportSource } from '../contract/define';
import type { Observability } from './audit';
import { type RequestContext, runWithRequestContext } from './context';
import { resolvePropagationContext } from './trace';

export interface RunUnitOfWorkOptions {
  /**
   * What the work is — `agent-loop`, `broadcast-send`, `scenario-tick`. A
   * request is named by its method and path; this is how a job is named, and
   * it is the field a dashboard groups by.
   */
  name: string;
  /**
   * Where the completion record goes — the value `createObservability`
   * returned. Without it the work still gets a context (so trace ids, dimensions
   * and the bounded logger behave), and nothing is recorded.
   */
  observability?: Observability;
  /**
   * Surface attribution. Defaults to `job`, which is not a transport and does
   * not claim to be one; pass `agent` or a name of your own where the work
   * belongs to a surface you already report under.
   */
  source?: TransportSource;
  /** Continue an existing trace — the `traceparent` of whatever scheduled this. */
  traceparent?: string;
  /** Domain dimensions known before the work starts; `setRequestDimensions` adds more. */
  dimensions?: Record<string, string>;
}

/**
 * Run `body` as one audited unit of work.
 *
 * The record is written whether the body returns or throws, and the throw is
 * re-thrown: observing work must not change what the work does. A failure is
 * recorded as `ok: false` with the error's own code when it has one, which is
 * the same thing a failed request's row says, minus the status a job never had.
 */
export async function runUnitOfWork<T>(
  options: RunUnitOfWorkOptions,
  body: () => Promise<T>,
): Promise<T> {
  const context: RequestContext = {
    trace: resolvePropagationContext(
      options.traceparent === undefined ? undefined : { traceparent: options.traceparent },
      undefined,
    ),
    source: options.source ?? 'job',
    kind: 'job',
    name: options.name,
    startedAt: process.hrtime.bigint(),
    ...(options.dimensions !== undefined && { dimensions: { ...options.dimensions } }),
  };
  const startedAtMs = Date.now();
  return runWithRequestContext(context, async () => {
    try {
      const value = await body();
      complete(options.observability, context, startedAtMs);
      return value;
    } catch (error) {
      // Recorded before the re-throw, and only when nothing else already
      // recorded one: a body that called `setRequestError` with a code knows
      // more about its own failure than this catch does.
      context.error ??= {
        ...(errorCodeOf(error) !== undefined && { code: errorCodeOf(error) }),
        message: error instanceof Error ? error.message : String(error),
      };
      complete(options.observability, context, startedAtMs);
      throw error;
    }
  });
}

function errorCodeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code: unknown = Reflect.get(error, 'code');
  return typeof code === 'string' ? code : undefined;
}

function complete(
  observability: Observability | undefined,
  context: RequestContext,
  startedAtMs: number,
): void {
  observability?.request?.complete({
    context,
    durationMs: Date.now() - startedAtMs,
  });
}
