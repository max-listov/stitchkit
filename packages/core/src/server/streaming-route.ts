/**
 * A long-lived response, with the three things everyone has to remember.
 *
 * `RawRoute` + `ctx.server` already gave every capability needed to serve a
 * continuing NDJSON or SSE body. The problem was never capability — it was that
 * the author of each such route had to independently remember three unrelated
 * things, and forgetting any one of them breaks the stream **silently**:
 *
 * 1. **Clear the generic HTTP idle timeout.** Without `server.timeout(req, 0)`
 *    Bun resets the connection after ten seconds. For a stream whose normal
 *    state is silence — a subscription to a rare event, the log of an idle
 *    process — that is a healthy connection being severed on a schedule.
 * 2. **Send a heartbeat.** Even with the timeout cleared, intermediate proxies
 *    and client stacks are under no obligation to hold a connection carrying no
 *    bytes.
 * 3. **Flush the headers at open.** A runtime does not send the response until
 *    the body produces something, so the consumer's `fetch` does not return
 *    until the first frame. On a quiet stream "subscribed and silent" becomes
 *    indistinguishable from "not answering" — and there is nothing to inspect,
 *    because there is no response yet.
 *
 * Each is obvious alone. Together they are a checklist that lived in the head
 * of whoever wrote the route rather than in the types — and a route written
 * later, doing the same job for another plane, got none of the three. Reviews
 * did not catch it and neither did the tests, because every test published an
 * event immediately and never lived long enough to reach the threshold. The
 * shape of the defect is the point: not "done wrong", but "done incompletely,
 * and the incompleteness is invisible".
 *
 * They are not independent, and the measurement is worth keeping: with a
 * heartbeat under the threshold, point 1 does not change the outcome in
 * process — either measure alone kept a connection alive through twelve
 * seconds of silence, and only dropping both killed it. Point 1 earns its place
 * against what a heartbeat cannot reach: a proxy or a client stack applying its
 * own idle rule. Points 2 and 3 are each load-bearing on their own.
 *
 * A fourth thing is handled here that is easy to not even think of:
 * **cancellation reaches the source.** When the consumer goes away, the async
 * iterable is returned, so a departed subscriber does not leave live work
 * running on the server.
 */

import type { HttpMethod } from '../contract/define';
import { normalizeError } from '../internal/errors';
import type { RawRoute, RawRouteContext } from './types';

/** How a value becomes bytes on the wire. The only thing the two formats differ in. */
export type StreamingFormat = 'ndjson' | 'sse';

/**
 * Default heartbeat, deliberately well under Bun's ten-second idle threshold.
 *
 * A default at or near the threshold does not protect anything: the first
 * pulse would arrive at about the moment the connection was already being
 * dropped, so the option would look configured and do nothing.
 */
export const DEFAULT_STREAM_HEARTBEAT_MS = 5_000;

export interface StreamingRouteOptions<TServer = unknown> {
  path: string;
  /** Default `GET` — a subscription is a read. */
  method?: HttpMethod | 'ALL';
  /** Wire framing. Default `ndjson`. */
  format?: StreamingFormat;
  /**
   * Interval between keep-alive frames while the source is silent. Default
   * `DEFAULT_STREAM_HEARTBEAT_MS`. Must be finite and positive.
   */
  heartbeatMs?: number;
  /**
   * Per-request idle timeout in **seconds**, applied through the runtime's own
   * per-request control where it has one (Bun). Default `0` — no timeout.
   *
   * Zero by default and not by accident. The generic timeout exists to reap
   * connections whose peer has gone quiet, and a stream whose normal state is
   * silence is the one case where that inference is wrong — which is the reason
   * this primitive is being reached for at all. It is still a field, because
   * removing a general limit is a decision worth being able to see and to
   * override.
   */
  idleTimeoutSeconds?: number;
  /**
   * The frames. Returned as an async iterable so a generator is the natural
   * way to write one.
   *
   * **A source that waits must honour `context.signal`.** See
   * `StreamingSourceContext` — this is the one part of cancellation the
   * primitive cannot do on the source's behalf.
   */
  source: (
    request: Request,
    context: StreamingSourceContext<TServer>,
  ) => AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>;
  /** Extra response headers. The framing headers below cannot be overridden. */
  headers?: Record<string, string>;
  /** Synchronous ownership hook invoked on every close/cancel/error path. */
  onClose?: () => void;
}

/**
 * What a source is given, and the reason the signal is not optional.
 *
 * Closing an async iterator is not enough to stop a source, and the mechanism
 * is worth stating because the failure is silent. An async generator serialises
 * its requests: `return()` issued while a `next()` is still in flight is
 * QUEUED behind it. A subscription source's `next()` is in flight almost all
 * the time — that is what a subscription is — so the return is queued behind a
 * promise that will only settle when the next event arrives, which for a quiet
 * plane may be never. `iterator.return()` is still called, because it does
 * close a source suspended at a `yield`; it simply cannot interrupt one that is
 * waiting.
 *
 * The signal is what can. It is aborted the moment the consumer goes away —
 * through either route, a request abort or a stream cancel, which are not the
 * same event — and a source that awaits on it stops immediately:
 *
 * ```ts
 * ndjsonRoute({
 *   path: '/events/subscribe',
 *   source: async function* (request, { signal }) {
 *     for await (const event of subscribe({ signal })) yield event
 *   },
 * })
 * ```
 */
export interface StreamingSourceContext<TServer = unknown> extends RawRouteContext<TServer> {
  /** Aborted when the consumer goes away. A waiting source must honour it. */
  signal: AbortSignal;
}

interface Framing {
  contentType: string;
  /** What is sent at open and while idle. */
  keepAlive: string;
  frame: (value: unknown) => string;
  /** Sent once when the source completes normally, if the format has a sentinel. */
  done?: string;
}

/**
 * NDJSON's keep-alive is an **empty line**, and that makes the reading rule —
 * "blank lines are skipped" — part of a documented contract rather than a verbal
 * agreement between the two halves of one project. `parseNDJSON` implements it.
 *
 * SSE has a keep-alive of its own: a comment line, which the specification
 * already requires every conforming reader to ignore. Its `[DONE]` sentinel
 * matches `streamSSE`, so `parseSSE` reads this route unchanged.
 */
const FRAMINGS: Record<StreamingFormat, Framing> = {
  ndjson: {
    contentType: 'application/x-ndjson',
    keepAlive: '\n',
    frame: (value) => `${JSON.stringify(value)}\n`,
  },
  sse: {
    contentType: 'text/event-stream',
    keepAlive: ': keep-alive\n\n',
    frame: (value) => `data: ${JSON.stringify(value)}\n\n`,
    done: 'data: [DONE]\n\n',
  },
};

/**
 * Ask the runtime to stop timing this request out.
 *
 * Duck-typed on purpose: `createHandler` is Web Fetch-clean (→ ADR 0013), so
 * this file must not name a Bun type. A runtime without per-request timeouts
 * simply has no such method and needs nothing done.
 */
function applyIdleTimeout(server: unknown, request: Request, seconds: number): void {
  if (typeof server !== 'object' || server === null) return;
  const timeout = Reflect.get(server, 'timeout');
  if (typeof timeout !== 'function') return;
  try {
    Reflect.apply(timeout, server, [request, seconds]);
  } catch {
    // A runtime that has the method but refuses this request is not a reason to
    // fail the subscription — the heartbeat is the portable half of the defence.
  }
}

/**
 * A heartbeat must never be the reason a process cannot exit.
 *
 * Duck-typed for the same reason `applyIdleTimeout` is: the timer handle's type
 * differs by runtime, and a runtime whose timers are plain numbers has nothing
 * to unref.
 */
function unrefTimer(timer: unknown): void {
  if (typeof timer !== 'object' || timer === null) return;
  const unref = Reflect.get(timer, 'unref');
  if (typeof unref === 'function') Reflect.apply(unref, timer, []);
}

/**
 * How many frames may wait for a consumer that is not reading. Small on
 * purpose: a subscription is a live feed, and a backlog of stale frames is
 * worth less than the memory it costs.
 */
const MAX_BUFFERED_FRAMES = 16;

/**
 * The framing headers win, case-insensitively.
 *
 * Spread does not do this. Object keys are case-sensitive and `Headers` built
 * from a record **append**, so `{ ...{'content-type': 'text/plain'},
 * 'Content-Type': 'application/x-ndjson' }` ships
 * `content-type: text/plain, application/x-ndjson` — a malformed type rather
 * than an overridden one, and the lower-case spelling is the one a consumer
 * naturally writes. `Headers.set` replaces regardless of case.
 */
function responseHeaders(
  framing: Framing,
  extra: Record<string, string> | undefined,
): Headers {
  const headers = new Headers(extra);
  headers.set('Content-Type', framing.contentType);
  headers.set('Cache-Control', 'no-cache');
  headers.set('Connection', 'keep-alive');
  // Proxies that buffer a response defeat every measure above by holding the
  // frames back until they have "enough".
  headers.set('X-Accel-Buffering', 'no');
  return headers;
}

/**
 * A `RawRoute` serving a continuing body.
 *
 * @see ndjsonRoute
 * @see sseRoute
 */
export function streamingRoute<TServer = unknown>(
  options: StreamingRouteOptions<TServer>,
): RawRoute<TServer> {
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_STREAM_HEARTBEAT_MS;
  if (!Number.isFinite(heartbeatMs) || heartbeatMs <= 0) {
    throw new TypeError('heartbeatMs must be a finite positive number of milliseconds');
  }
  const idleTimeoutSeconds = options.idleTimeoutSeconds ?? 0;
  if (!Number.isInteger(idleTimeoutSeconds) || idleTimeoutSeconds < 0) {
    throw new TypeError('idleTimeoutSeconds must be a non-negative integer');
  }
  const framing = FRAMINGS[options.format ?? 'ndjson'];

  return {
    method: options.method ?? 'GET',
    path: options.path,
    handler: async (request, context) => {
      applyIdleTimeout(context.server, request, idleTimeoutSeconds);
      const departed = new AbortController();
      const iterable = await options.source(request, { ...context, signal: departed.signal });
      const iterator = iterable[Symbol.asyncIterator]();
      const encoder = new TextEncoder();
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      let closed = false;

      const stopHeartbeat = (): void => {
        if (heartbeat === null) return;
        clearInterval(heartbeat);
        heartbeat = null;
      };

      // One place that ends everything, because there are four ways to get
      // here — the source finished, the source threw, the consumer aborted the
      // request, the runtime cancelled the stream — and anything left running
      // on any of them is work nobody is waiting for.
      //
      // Synchronous on purpose: it must never be possible for closing down to
      // wait on the very source that is refusing to finish. And total on
      // purpose: `source` is typed `AsyncIterable`, not `AsyncGenerator`, so a
      // hand-written `return()` may be synchronous, return a non-thenable, or
      // throw — and this runs from a detached context where a throw would be an
      // unhandled rejection.
      const release = (): void => {
        if (closed) return;
        closed = true;
        try {
          options.onClose?.();
          stopHeartbeat();
          // A pump parked on backpressure must not stay parked: nothing will
          // ever ask for more once the consumer is gone.
          signalDemand();
          // Tells a waiting source to stop. This is the half that works when
          // the source is parked on its next value (→ `StreamingSourceContext`).
          departed.abort();
          // And this is the half that works when it is parked on a `yield`.
          void Promise.resolve(iterator.return?.(undefined)).catch(() => undefined);
        } catch {
          // A source that cannot be closed cleanly is still closed as far as
          // this response is concerned.
        }
      };

      // Resolved by `pull` — the stream machinery's own "I have room now".
      let demand: (() => void) | null = null;
      const signalDemand = (): void => {
        const resolve = demand;
        demand = null;
        resolve?.();
      };

      const stream = new ReadableStream(
        {
          start(controller) {
            const send = (text: string): boolean => {
              if (closed) return false;
              try {
                controller.enqueue(encoder.encode(text));
                return true;
              } catch {
                // The consumer went away between the check and the write.
                release();
                return false;
              }
            };

            const finish = (): void => {
              try {
                controller.close();
              } catch {
                // Already closed — an abort during the final frame, or the
                // runtime tearing the request down.
              }
            };

            // A signal that is ALREADY aborted never fires its listener, so the
            // check has to come first: a request whose consumer left before the
            // handler ran would otherwise leave a heartbeat and an open
            // iterator behind with nothing left to stop them.
            if (request.signal.aborted) {
              release();
              finish();
              return;
            }
            request.signal.addEventListener('abort', () => {
              release();
              finish();
            });

            // Point 3, and it happens before anything else can take time: the
            // headers are on the wire at open, so a consumer's `fetch` resolves
            // whether or not the source has anything to say yet.
            send(framing.keepAlive);
            heartbeat = setInterval(() => {
              // Skipped while the queue is full. A keep-alive exists to hold an
              // IDLE connection open; feeding one whose consumer has stopped
              // reading only grows a buffer nobody is draining.
              if ((controller.desiredSize ?? 1) > 0) send(framing.keepAlive);
            }, heartbeatMs);
            // A heartbeat must never be the reason a process cannot exit.
            unrefTimer(heartbeat);

            /**
             * Wait until the stream has room.
             *
             * Backpressure has to be explicit here, because the obvious
             * alternatives both fail. Enqueueing unconditionally — what the
             * first version did — lets a source faster than the network buffer
             * without limit: 200 000 frames left a source in three seconds
             * against a reader that never read a byte. Serving frames from
             * `pull` instead is the textbook shape and does bound the queue,
             * but with an always-ready source the runtime never yields to flush
             * the response, so the consumer's `fetch` does not return at all —
             * measured, and a direct contradiction of point 3.
             *
             * So the pump stays, and it asks. `pull` is called exactly when
             * there is room again, and that is what wakes this.
             */
            const awaitDemand = async (): Promise<void> => {
              while (!closed && (controller.desiredSize ?? 1) <= 0) {
                await new Promise<void>((resolve) => {
                  demand = resolve;
                });
              }
            };

            // Deliberately NOT awaited. `start` resolving is what lets the
            // runtime deliver `cancel` — and a source that never yields would
            // otherwise keep `start` pending forever, so a consumer's disconnect
            // could not reach the iterator at all. That is not a hypothetical:
            // it is exactly the silent-subscription case this primitive is for.
            // Frames sent since the loop last yielded to the runtime.
            let sinceYield = 0;

            void (async () => {
              try {
                for (;;) {
                  await awaitDemand();
                  if (closed) return;
                  const next = await iterator.next();
                  if (closed) return;
                  if (next.done) break;
                  if (!send(framing.frame(next.value))) return;
                  sinceYield += 1;
                  if (sinceYield >= MAX_BUFFERED_FRAMES) {
                    sinceYield = 0;
                    // A source that is ALWAYS ready starves the runtime, and
                    // the consequence is not slowness — it is that the response
                    // never leaves. `await iterator.next()` on a generator that
                    // is never waiting resolves as a microtask, so the loop can
                    // spin for millions of frames without the event loop ever
                    // getting a turn to flush the headers or fire a timer. That
                    // was measured: 19.5 million frames and a `fetch` on the
                    // other end that never returned. A macrotask hand-back
                    // every full queue costs nothing on a source that waits —
                    // the ordinary case — and makes the pathological one
                    // behave.
                    await new Promise<void>((resolve) => {
                      setTimeout(resolve, 0);
                    });
                    if (closed) return;
                  }
                }
                if (framing.done) send(framing.done);
              } catch (error) {
                // The headers left long ago, so there is no status left to
                // send. The envelope is the same one `errorResponse` would have
                // produced, normalised so an internal failure never reaches the
                // wire raw.
                if (!closed) send(framing.frame(normalizeError(error).toJSON()));
              } finally {
                release();
                finish();
              }
            })();
          },

          pull() {
            signalDemand();
          },

          cancel() {
            release();
          },
        },
        // Bounded, and small: a subscription is a live feed, not a download.
        { highWaterMark: MAX_BUFFERED_FRAMES },
      );

      return new Response(stream, { headers: responseHeaders(framing, options.headers) });
    },
  };
}

/** A `streamingRoute` framed as newline-delimited JSON. Keep-alive is a blank line. */
export function ndjsonRoute<TServer = unknown>(
  options: Omit<StreamingRouteOptions<TServer>, 'format'>,
): RawRoute<TServer> {
  return streamingRoute({ ...options, format: 'ndjson' });
}

/** A `streamingRoute` framed as Server-Sent Events — readable by `parseSSE`. */
export function sseRoute<TServer = unknown>(
  options: Omit<StreamingRouteOptions<TServer>, 'format'>,
): RawRoute<TServer> {
  return streamingRoute({ ...options, format: 'sse' });
}
