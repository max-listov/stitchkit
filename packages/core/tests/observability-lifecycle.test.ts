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
