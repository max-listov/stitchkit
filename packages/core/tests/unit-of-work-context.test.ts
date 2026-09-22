/*
 * Work that outlives the request that started it.
 *
 * An agent loop is launched fire-and-forget and survives the call that launched
 * it; a broadcast runs on a schedule; a scenario engine ticks. Each has a
 * start, a duration and an outcome, and none of them arrived over a transport —
 * but the context they had to run in required `method` and `path`. So a
 * consuming loop wrote `method: 'AGENT'`, which is not a verb, it is the
 * absence of one recorded in the field for verbs; and the two that had no
 * context at all were absent from the audit entirely, with
 * `setRequestDimensions` a silent no-op inside them.
 *
 * The transport fields are now absent rather than invented, and — the part that
 * is easy to miss — so is `statusCode`. Dropping `method: 'AGENT'` while still
 * demanding an HTTP status would have replaced one fabricated transport field
 * with another in the same row.
 */
import { describe, expect, test } from 'bun:test';
import { createObservability } from '../src/observability';
import { setRequestDimensions } from '../src/observability/context';
import type { RequestEvent } from '../src/observability/event';
import { runUnitOfWork } from '../src/observability/work';

function collector(): {
  events: RequestEvent[];
  observability: ReturnType<typeof createObservability>;
} {
  const events: RequestEvent[] = [];
  const observability = createObservability({
    request: { write: (event) => void events.push(event) },
  });
  return { events, observability };
}

/** The sink is fire-and-forget; this is the settle point the API gives. */
async function settled(observability: ReturnType<typeof createObservability>): Promise<void> {
  await observability.flush();
}

describe('work with no transport is audited as itself', () => {
  test('a completed job is recorded with its name and no invented transport', async () => {
    const { events, observability } = collector();
    await runUnitOfWork({ name: 'broadcast-send', observability }, async () => 'sent');
    await settled(observability);

    const [event] = events;
    expect(event?.kind).toBe('job');
    expect(event?.name).toBe('broadcast-send');
    expect(event?.ok).toBe(true);
    // The three fields a job has no honest value for.
    expect(event?.method).toBeUndefined();
    expect(event?.path).toBeUndefined();
    expect(event?.statusCode).toBeUndefined();
  });

  test('the duration is measured, which is the thing that was written by hand before', async () => {
    const { events, observability } = collector();
    await runUnitOfWork({ name: 'slow', observability }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 12));
    });
    await settled(observability);
    expect(events[0]?.durationMs).toBeGreaterThanOrEqual(10);
  });

  test('a throwing body is recorded as a failure and still throws', async () => {
    const { events, observability } = collector();
    const failure = Object.assign(new Error('provider refused'), { code: 'UPSTREAM' });
    await expect(
      runUnitOfWork({ name: 'agent-loop', observability }, async () => {
        throw failure;
      }),
    ).rejects.toThrow('provider refused');
    await settled(observability);

    expect(events[0]?.ok).toBe(false);
    expect(events[0]?.errorCode).toBe('UPSTREAM');
    // Observing work must not change what the work does.
    expect(events[0]?.name).toBe('agent-loop');
  });

  test('`setRequestDimensions` works inside, where it used to be a silent no-op', async () => {
    const { events, observability } = collector();
    await runUnitOfWork({ name: 'broadcast-send', observability }, async () => {
      setRequestDimensions({ projectId: 'p-1' });
    });
    await settled(observability);
    expect(events[0]?.dimensions).toEqual({ projectId: 'p-1' });
  });

  test('an inbound traceparent is continued, so the job joins the trace that scheduled it', async () => {
    const { events, observability } = collector();
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    await runUnitOfWork(
      {
        name: 'scenario-tick',
        observability,
        traceparent: `00-${traceId}-00f067aa0ba902b7-01`,
      },
      async () => undefined,
    );
    await settled(observability);
    expect(events[0]?.traceId).toBe(traceId);
  });

  test('source says what it is and does not claim a transport', async () => {
    const { events, observability } = collector();
    await runUnitOfWork({ name: 'x', observability }, async () => undefined);
    await settled(observability);
    expect(events[0]?.source).toBe('job');
  });

  test('a named source is kept, for work that belongs to a surface already reported', async () => {
    const { events, observability } = collector();
    await runUnitOfWork({ name: 'x', observability, source: 'agent' }, async () => undefined);
    await settled(observability);
    expect(events[0]?.source).toBe('agent');
  });

  test('without an observability object the work still runs inside a context', async () => {
    // The context is what makes dimensions, trace ids and the bounded logger
    // behave; recording is a separate decision.
    let inside: string | undefined;
    await runUnitOfWork({ name: 'x' }, async () => {
      setRequestDimensions({ a: '1' });
      inside = 'ran';
    });
    expect(inside).toBe('ran');
  });
});

/*
 * And the half that must not have moved: a request.
 *
 * Every field a request's row carried before is still there, and `kind` is
 * written on it too. A filter that had to infer "no `method` means a job" would
 * be carrying exactly the implicit knowledge this field exists to remove.
 */
describe('a request row is unchanged, and now says so explicitly', () => {
  test('an HTTP request still carries verb, path and status, and is marked a request', async () => {
    const { events, observability } = collector();
    const observer = observability.request;
    if (!observer) throw new Error('expected a request observer');
    observer.complete({
      context: {
        trace: { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) },
        source: 'http',
        kind: 'request',
        method: 'POST',
        path: '/projects',
        startedAt: process.hrtime.bigint(),
      },
      statusCode: 201,
      durationMs: 5,
    });
    await settled(observability);

    expect(events[0]).toMatchObject({
      kind: 'request',
      method: 'POST',
      path: '/projects',
      statusCode: 201,
      ok: true,
    });
  });

  test('a tool-call row is marked a request too', async () => {
    // Tool rows go to a different sink and were the easy half to forget: a
    // filter reading `kind` must not find it missing on a third of the table.
    const events: RequestEvent[] = [];
    const observability = createObservability({
      tools: { write: (event) => void events.push(event) },
    });
    await observability.toolCall.afterToolCall?.({
      toolName: 'render_media',
      args: {},
      result: { ok: true, data: { id: 'x' } },
      durationMs: 3,
      context: { source: 'mcp' },
      endpoint: { serviceName: 'media', key: 'render', method: 'POST' },
    } as never);
    await observability.flush();
    expect(events[0]?.kind).toBe('request');
    expect(events[0]?.method).toBe('TOOL');
  });

  test('a context written before `kind` existed still reads as a request', async () => {
    // Nothing in a consuming application has to start declaring it.
    const { events, observability } = collector();
    observability.request?.complete({
      context: {
        trace: { traceId: 'c'.repeat(32), spanId: 'd'.repeat(16) },
        source: 'http',
        method: 'GET',
        path: '/health',
        startedAt: process.hrtime.bigint(),
      },
      statusCode: 200,
      durationMs: 1,
    });
    await settled(observability);
    expect(events[0]?.kind).toBe('request');
  });
});

/*
 * `auditChanges` is the filter most projects hand to the sink, and it reads the
 * verb. A job has none, so the question it answers — did this change anything —
 * cannot be answered from the row.
 */
describe('the change filter keeps what it cannot examine', () => {
  const row = (event: Partial<RequestEvent>): RequestEvent =>
    ({
      source: 'job',
      kind: 'job',
      traceId: 'e'.repeat(32),
      spanId: 'f'.repeat(16),
      ok: true,
      durationMs: 1,
      payload: null,
      resultSize: null,
      responseBytes: 0,
      ...event,
    }) as RequestEvent;

  test('a job with no verb is kept', async () => {
    const { auditChanges } = await import('../src/observability/changes');
    // Dropping it would report zero mutations and look exactly like a system in
    // which nothing happened.
    expect(auditChanges(row({ name: 'broadcast-send' }))).toBe(true);
  });

  test('a GET request is still dropped', async () => {
    const { auditChanges } = await import('../src/observability/changes');
    expect(
      auditChanges(row({ kind: 'request', method: 'GET', path: '/x', statusCode: 200 })),
    ).toBe(false);
  });

  test('a 403 is still kept whatever the verb', async () => {
    const { auditChanges } = await import('../src/observability/changes');
    expect(
      auditChanges(row({ kind: 'request', method: 'GET', path: '/x', statusCode: 403 })),
    ).toBe(true);
  });
});
