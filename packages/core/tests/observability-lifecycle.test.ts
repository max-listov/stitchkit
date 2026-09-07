import { describe, expect, test } from 'bun:test';
import {
  createObservability,
  createTraceContext,
  type RequestContext,
  type RequestEvent,
} from '../src/observability';

function context(path: string): RequestContext {
  return {
    trace: createTraceContext(),
    source: 'http',
    method: 'GET',
    path,
    startedAt: process.hrtime.bigint(),
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('Asynchronous observability work did not start');
}

describe('managed observability sink lifecycle', () => {
  test('reports sync and async sink failures once without failing flush', async () => {
    const failures: string[] = [];
    let calls = 0;
    const observability = createObservability({
      request: {
        write: () => {
          calls += 1;
          if (calls === 1) throw new Error('sync');
          return Promise.reject(new Error('async'));
        },
        onSinkError: ({ error, event }) => {
          failures.push(
            `${error instanceof Error ? error.message : 'unknown'}:${event?.path}`,
          );
        },
      },
    });
    observability.request?.complete({
      context: context('/one'),
      statusCode: 200,
      durationMs: 1,
    });
    observability.request?.complete({
      context: context('/two'),
      statusCode: 200,
      durationMs: 1,
    });
    await observability.flush();
    await Promise.resolve();
    expect(failures).toEqual(['sync:/one', 'async:/two']);
    expect(observability.getStatus().request).toMatchObject({
      received: 2,
      accepted: 2,
      completed: 0,
      failed: 2,
      pending: 0,
    });
  });

  test('flush waits only for the generation admitted before it starts', async () => {
    const first = deferred();
    const second = deferred();
    const starts: string[] = [];
    const observability = createObservability({
      request: {
        write: async (event) => {
          starts.push(event.path);
          await (event.path === '/first' ? first.promise : second.promise);
        },
      },
    });
    observability.request?.complete({
      context: context('/first'),
      statusCode: 200,
      durationMs: 1,
    });
    const flushing = observability.flush();
    observability.request?.complete({
      context: context('/second'),
      statusCode: 200,
      durationMs: 1,
    });
    await waitFor(() => starts.length === 2);
    expect(starts).toEqual(['/first', '/second']);
    let flushed = false;
    void flushing.then(() => {
      flushed = true;
    });
    first.resolve();
    await flushing;
    expect(flushed).toBe(true);
    second.resolve();
    await observability.flush();
  });

  test('bounds pending writes and reports capacity drops', async () => {
    const held = deferred();
    const writes: string[] = [];
    const drops: Array<{ reason: string; path: string; pending: number }> = [];
    const observability = createObservability({
      request: {
        maxPending: 1,
        write: async (event) => {
          writes.push(event.path);
          await held.promise;
        },
        onDrop: ({ reason, event, pending }) => {
          drops.push({ reason, path: event.path, pending });
        },
      },
    });
    observability.request?.complete({
      context: context('/kept'),
      statusCode: 200,
      durationMs: 1,
    });
    await waitFor(() => writes.length === 1);
    observability.request?.complete({
      context: context('/dropped'),
      statusCode: 200,
      durationMs: 1,
    });
    await waitFor(() => drops.length === 1);
    expect(writes).toEqual(['/kept']);
    expect(drops).toEqual([{ reason: 'capacity', path: '/dropped', pending: 1 }]);
    held.resolve();
    await observability.flush();
    expect(observability.getStatus().request).toMatchObject({
      received: 2,
      accepted: 1,
      completed: 1,
      dropped: 1,
      pending: 0,
    });
  });

  test('filtered events do not consume capacity', async () => {
    const held = deferred();
    const writes: string[] = [];
    const observability = createObservability({
      request: {
        maxPending: 1,
        filter: (event) => event.path !== '/filtered',
        write: async (event) => {
          writes.push(event.path);
          await held.promise;
        },
      },
    });
    observability.request?.complete({
      context: context('/filtered'),
      statusCode: 200,
      durationMs: 1,
    });
    await Promise.resolve();
    observability.request?.complete({
      context: context('/kept'),
      statusCode: 200,
      durationMs: 1,
    });
    await waitFor(() => writes.length === 1);
    expect(writes).toEqual(['/kept']);
    held.resolve();
    const report = await observability.close();
    expect(report.request).toMatchObject({ filtered: 1, accepted: 1, completed: 1 });
  });

  test('close is idempotent, drains accepted writes and reports closed admission', async () => {
    const held = deferred();
    const drops: RequestEvent[] = [];
    const observability = createObservability({
      request: {
        write: () => held.promise,
        onDrop: ({ reason, event }) => {
          if (reason === 'closed') drops.push(event);
        },
      },
    });
    observability.request?.complete({
      context: context('/accepted'),
      statusCode: 200,
      durationMs: 1,
    });
    const closing = observability.close();
    expect(observability.close()).toBe(closing);
    observability.request?.complete({
      context: context('/closed'),
      statusCode: 200,
      durationMs: 1,
    });
    await waitFor(() => drops.length === 1);
    expect(drops.map((event) => event.path)).toEqual(['/closed']);
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    held.resolve();
    const report = await closing;
    expect(closed).toBe(true);
    expect(report.request).toMatchObject({
      received: 2,
      accepted: 1,
      completed: 1,
      dropped: 1,
      pending: 0,
      closed: true,
    });
    expect(report.request).toEqual(report.total);
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.request)).toBe(true);
  });

  test('diagnostic callback failures stay isolated', async () => {
    const observability = createObservability({
      request: {
        maxPending: 1,
        write: () => {
          throw new Error('sink failed');
        },
        onSinkError: () => Promise.reject(new Error('diagnostic failed')),
        onDrop: () => {
          throw new Error('drop diagnostic failed');
        },
      },
    });
    observability.request?.complete({
      context: context('/failure'),
      statusCode: 500,
      durationMs: 1,
    });
    await expect(observability.close()).resolves.toMatchObject({
      request: { accepted: 1, failed: 1, closed: true },
    });
    observability.request?.complete({
      context: context('/closed'),
      statusCode: 200,
      durationMs: 1,
    });
    await Promise.resolve();
    await Promise.resolve();
  });

  test('validates maxPending fail-first', () => {
    expect(() =>
      createObservability({ request: { maxPending: 0, write: () => undefined } }),
    ).toThrow('positive safe integer');
  });

  test('separates preparation failures from admitted write failures', async () => {
    const failures: unknown[] = [];
    const observability = createObservability({
      request: {
        filter: () => {
          throw new Error('filter failed');
        },
        write: () => undefined,
        onSinkError: ({ error }) => {
          failures.push(error);
        },
      },
    });
    observability.request?.complete({
      context: context('/filter-error'),
      statusCode: 200,
      durationMs: 1,
    });
    await observability.flush();
    expect(failures).toHaveLength(1);
    expect(observability.getStatus().request).toMatchObject({
      received: 1,
      accepted: 0,
      preparationFailed: 1,
      failed: 0,
    });
  });

  test('aggregates enabled surfaces without losing their individual capacity', async () => {
    const observability = createObservability({
      request: { maxPending: 3, write: () => undefined },
      tools: { maxPending: 7, write: () => undefined },
    });
    const open = observability.getStatus();
    expect(open.request?.capacity).toBe(3);
    expect(open.tools?.capacity).toBe(7);
    expect(open.total).toMatchObject({ capacity: 10, closed: false });

    const firstClose = observability.close();
    expect(observability.close()).toBe(firstClose);
    const report = await firstClose;
    expect(report.total).toMatchObject({ capacity: 10, closed: true });
    expect(report.request?.closed).toBe(true);
    expect(report.tools?.closed).toBe(true);
  });
});

/**
 * A drain that cannot be bounded cannot take part in a shutdown budget.
 *
 * Measured by a consumer on production: five forced shutdowns in a week, each
 * one burning the whole 110-second budget with every application operation
 * already completed and the transport closed in 26 ms. The distinguishing
 * signal was the finalisation log reaching the line before `close()` and never
 * the line after it — and between them stands exactly one call.
 */
describe('bounded observability drain', () => {
  function stuckSink(): {
    observability: ReturnType<typeof createObservability>;
    started: () => number;
  } {
    let started = 0;
    const observability = createObservability({
      request: {
        write: () => {
          started += 1;
          // The failure being reproduced: a write that never settles, the way a
          // database that has stopped answering behaves.
          return new Promise<void>(() => undefined);
        },
      },
    });
    return { observability, started: () => started };
  }

  function admit(
    observability: ReturnType<typeof createObservability>,
    path = '/stuck',
  ): void {
    observability.request?.complete({
      context: context(path),
      statusCode: 200,
      durationMs: 1,
    });
  }

  test('a stuck write does not hold close past the caller timeout', async () => {
    const { observability, started } = stuckSink();
    admit(observability);
    await waitFor(() => started() === 1);

    const report = await observability.close({ timeoutMs: 20 });

    expect(report.drained).toBe(false);
    expect(report.total).toMatchObject({
      accepted: 1,
      completed: 0,
      pending: 1,
      closed: true,
    });
    // The two numbers a shutdown log can state: what the drain was still
    // waiting for, and everything the sink has not written for any reason.
    const total = report.total;
    expect(total.pending + total.preparing).toBe(1);
    expect(total.received - total.filtered - total.completed).toBe(1);
  });

  test('a timeout and a signal together are both honoured', async () => {
    const { observability } = stuckSink();
    admit(observability);
    const controller = new AbortController();
    // The signal wins: a long timeout must not be what the caller waits for.
    const closing = observability.close({ timeoutMs: 60_000, signal: controller.signal });
    controller.abort();
    expect((await closing).drained).toBe(false);

    const { observability: other } = stuckSink();
    admit(other);
    // The timeout wins: a signal that never aborts must not make it unbounded.
    expect(
      (await other.close({ timeoutMs: 20, signal: new AbortController().signal })).drained,
    ).toBe(false);
  });

  test('a bound that expires on a sink that finished reports a complete drain', async () => {
    // The false alarm this guards: a shutdown holds one budget signal, an
    // earlier step already tripped it, and `close` is reached with an
    // already-aborted signal over a sink that drains in one microtask. Read
    // from the race, that says `drained: false` with nothing unwritten, and the
    // guide tells the consumer to log it as lost audit.
    const observability = createObservability({ request: { write: () => undefined } });
    admit(observability, '/ok');
    await observability.close();

    const report = await observability.close({ signal: AbortSignal.abort() });

    expect(report.drained).toBe(true);
    expect(report.total).toMatchObject({ completed: 1, pending: 0, preparing: 0 });
  });

  test('the report is never read mid-update, whenever the signal lands', async () => {
    // An abort listener fires SYNCHRONOUSLY inside whoever calls abort(), so a
    // bounded report lands between a counter and its map. It used to count one
    // event as both `preparing` and `pending`, and to report `accepted` below
    // `completed + pending` — an impossible sink.
    for (let ticks = 0; ticks <= 6; ticks += 1) {
      const observability = createObservability({
        request: { write: () => Promise.resolve() },
      });
      admit(observability, '/e');
      const controller = new AbortController();
      const closing = observability.close({ signal: controller.signal });
      let chain = Promise.resolve();
      for (let step = 0; step < ticks; step += 1) chain = chain.then(() => undefined);
      void chain.then(() => controller.abort());

      const { total } = await closing;

      expect({ ticks, impossible: total.accepted < total.completed + total.pending }).toEqual({
        ticks,
        impossible: false,
      });
      expect({ ticks, unwritten: total.pending + total.preparing }).toEqual({
        ticks,
        unwritten: total.completed === 1 ? 0 : 1,
      });
    }
  });

  test('a healthy sink drains inside its bound and says so', async () => {
    const held = deferred();
    const observability = createObservability({ request: { write: () => held.promise } });
    admit(observability, '/ok');
    held.resolve();

    const report = await observability.close({ timeoutMs: 1_000 });

    expect(report.drained).toBe(true);
    expect(report.total).toMatchObject({ accepted: 1, completed: 1, pending: 0 });
  });

  test('a zero timeout still grants the drain whatever settles without waiting', async () => {
    // Not a claim that zero preempts everything: `setTimeout(0)` is a
    // macrotask, so every microtask-resolvable write completes first. A bound
    // limits waiting for I/O, it cannot preempt a sink that occupies the loop.
    const synchronous = createObservability({ request: { write: () => undefined } });
    admit(synchronous, '/sync');
    expect((await synchronous.close({ timeoutMs: 0 })).drained).toBe(true);

    const { observability } = stuckSink();
    admit(observability);
    expect((await observability.close({ timeoutMs: 0 })).drained).toBe(false);
  });

  test('a second, shorter bound observes the same drain rather than starting another', async () => {
    const { observability, started } = stuckSink();
    admit(observability);
    await waitFor(() => started() === 1);

    const first = await observability.close({ timeoutMs: 10 });
    await new Promise((resolve) => setTimeout(resolve, 120));
    const second = await observability.close({ timeoutMs: 10 });

    expect(second.drained).toBe(false);
    expect(started()).toBe(1);
    // The decisive assertion, and the one this test used to lack: `durationMs`
    // is the age of the SHARED drain. A second drain would have restarted the
    // clock and reported roughly its own bound instead.
    expect(first.durationMs).toBeLessThan(100);
    expect(second.durationMs).toBeGreaterThan(100);
  });

  test('flush is bounded the same way and returns whether its generation settled', async () => {
    const { observability, started } = stuckSink();
    admit(observability);
    await waitFor(() => started() === 1);

    expect(await observability.flush({ timeoutMs: 20 })).toBe(false);
    const controller = new AbortController();
    const flushing = observability.flush({ signal: controller.signal });
    controller.abort();
    expect(await flushing).toBe(false);
    // Admission is untouched: flush bounds the wait, it does not close.
    expect(observability.getStatus().total).toMatchObject({ pending: 1, closed: false });

    const healthy = createObservability({ request: { write: () => undefined } });
    admit(healthy, '/ok');
    expect(await healthy.flush({ timeoutMs: 1_000 })).toBe(true);
  });

  test('an unbounded close is unchanged, and reports a complete drain', async () => {
    const observability = createObservability({ request: { write: () => undefined } });
    admit(observability, '/ok');

    const closing = observability.close();
    // Same promise, the way it has always been.
    expect(observability.close()).toBe(closing);
    const report = await closing;

    expect(report.drained).toBe(true);
    expect(report.total).toMatchObject({ accepted: 1, completed: 1, pending: 0 });
  });

  test('a timeout that is not a non-negative finite number is refused, and closes nothing', () => {
    const observability = createObservability({ request: { write: () => undefined } });
    // Both methods throw the SAME way. `expect(fn).toThrow` cannot check this:
    // it passes for a function that returns a rejected promise too, so it is
    // blind to exactly the difference being pinned — an `async` method turns
    // the identical bad input into a rejection a `.catch` would see and a
    // synchronous `try` would not.
    const call = (invoke: () => unknown): { threw: boolean; returned: unknown } => {
      try {
        return { threw: false, returned: invoke() };
      } catch (error) {
        expect(String(error)).toMatch(/non-negative finite/);
        return { threw: true, returned: undefined };
      }
    };
    expect(call(() => observability.close({ timeoutMs: -1 }))).toEqual({
      threw: true,
      returned: undefined,
    });
    expect(call(() => observability.flush({ timeoutMs: Number.NaN }))).toEqual({
      threw: true,
      returned: undefined,
    });
    // A refused call has no effect: admission is open, not half-closed.
    expect(observability.getStatus().total.closed).toBe(false);
  });
});
