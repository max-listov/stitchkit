/**
 * The pump behind a streaming route: frames move from the source to the
 * response one per unit of demand, the runtime gets a turn after every full
 * queue, and every way out — done, a throw, a departed consumer — ends the
 * stream through the one `end` it is given.
 */
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

import { normalizeError } from '../contract/normalize';
import { isStreamCancellation } from './http-stream-lifetime';

/** How a value becomes bytes on the wire. The only thing the two formats differ in. */
import { type Framing, MAX_BUFFERED_FRAMES } from './streaming-route';

export interface FramePump {
  readonly iterator: AsyncIterator<unknown>;
  readonly framing: Framing;
  send(text: string): boolean;
  awaitDemand(): Promise<void>;
  isClosed(): boolean;
  readonly departed: AbortSignal;
  readonly pumped: PromiseWithResolvers<void>;
  /** Release the source and close the stream — the one way out of the pump. */
  end(): void;
}

/**
 * Move frames from the source to the stream, one per unit of demand, and end
 * the stream on every way out: done, a throw, a departed consumer.
 */
export async function pumpFrames(p: FramePump): Promise<void> {
  // Frames sent since the loop last yielded to the runtime.
  let sinceYield = 0;
  try {
    for (;;) {
      await p.awaitDemand();
      if (p.isClosed()) return;
      const next = await p.iterator.next();
      if (p.isClosed()) return;
      if (next.done) break;
      if (!p.send(p.framing.frame(next.value))) return;
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
        if (p.isClosed()) return;
      }
    }
    if (p.framing.done) p.send(p.framing.done);
  } catch (error) {
    // The headers left long ago, so there is no status left to
    // send. The envelope is the same one `errorResponse` would have
    // produced, normalised so an internal failure never reaches the
    // wire raw.
    if (p.isClosed()) {
      if (!isStreamCancellation(error, p.departed)) p.pumped.reject(error);
    } else p.send(p.framing.frame(normalizeError(error).toJSON()));
  } finally {
    p.pumped.resolve();
    p.end();
  }
}
