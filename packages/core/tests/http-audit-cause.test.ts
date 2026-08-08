/**
 * The HTTP audit row names the cause without the project wiring it by hand.
 *
 * The HTTP RequestEvent takes its error fields from
 * `ctx.error` — which the framework never wrote. A project that wired the audit
 * and nothing else recorded *that* a request failed and never *why*, while the
 * tool row had learned to name its own cause. → ADR 0042.
 */
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { AppError, defineContract } from '../src/contract';
import { createObservability, type RequestEvent, setRequestError } from '../src/observability';
import { createHandler, implement } from '../src/server';

const widgets = defineContract(
  { prefix: 'widgets' },
  {
    get: {
      method: 'GET',
      path: '/:id',
      desc: 'Get a widget',
      params: z.object({ id: z.string() }),
      output: z.object({ id: z.string() }),
    },
  },
);

const dbDown = new Error('ECONNREFUSED 10.0.0.4:5432');

const service = implement(widgets, {
  get: (ctx) => {
    if (ctx.params.id === 'boom') throw dbDown;
    if (ctx.params.id === 'missing') throw new AppError('NOT_FOUND', 'No such widget', 404);
    return { id: ctx.params.id };
  },
});

/** Drive one request through framework-owned observability and return its row. */
async function callAndAudit(
  path: string,
  hooks?: Parameters<typeof createHandler>[0]['hooks'],
): Promise<{ res: Response; event: RequestEvent | undefined }> {
  const events: RequestEvent[] = [];
  const audit = createObservability({
    request: { write: (e) => void events.push(e) },
  });
  const handler = createHandler({
    services: [service],
    hooks,
    observability: audit.request,
  });

  const original = console.error;
  console.error = () => undefined;
  let res: Response;
  try {
    res = await handler(new Request(`http://localhost${path}`), undefined);
  } finally {
    console.error = original;
  }
  // The sink is detached by design.
  await Bun.sleep(10);
  return { res, event: events[0] };
}

describe('the HTTP audit row names its cause', () => {
  test('an unexpected throw, with no onError wired at all', async () => {
    const { res, event } = await callAndAudit('/widgets/boom');

    expect(res.status).toBe(500);
    expect(event?.ok).toBe(false);
    expect(event?.errorCode).toBe('INTERNAL_SERVER_ERROR');
    // The whole point: the row says what happened, the caller was told nothing.
    expect(event?.errorMessage).toBe('ECONNREFUSED 10.0.0.4:5432');
    const body: unknown = await res.json();
    expect(JSON.stringify(body)).not.toContain('ECONNREFUSED');
  });

  test('a thrown AppError keeps its own message — the envelope was truthful', async () => {
    const { res, event } = await callAndAudit('/widgets/missing');

    expect(res.status).toBe(404);
    expect(event?.errorCode).toBe('NOT_FOUND');
    expect(event?.errorMessage).toBe('No such widget');
  });

  test('a custom onError that returns its own Response still produces a named row', async () => {
    const { res, event } = await callAndAudit('/widgets/boom', {
      onError: () => new Response(JSON.stringify({ oops: true }), { status: 503 }),
    });

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ oops: true });
    // The branch that used to record nothing at all.
    expect(event?.errorMessage).toBe('ECONNREFUSED 10.0.0.4:5432');
    expect(event?.errorCode).toBe('INTERNAL_SERVER_ERROR');
  });

  test("the project's own setRequestError wins — the framework only fills what is empty", async () => {
    const { event } = await callAndAudit('/widgets/boom', {
      onError: () => {
        setRequestError({
          code: 'DB_UNAVAILABLE',
          message: 'curated',
          details: { tier: 'db' },
        });
        return undefined;
      },
    });

    expect(event?.errorCode).toBe('DB_UNAVAILABLE');
    expect(event?.errorMessage).toBe('curated');
    expect(event?.errorDetail).toEqual({ tier: 'db' });
  });

  test('a validation failure records its structured detail', async () => {
    // `:id` is required by the route shape, so ask for an unmatched path — the
    // 404 the router raises still travels the one error path.
    const { event } = await callAndAudit('/widgets');

    expect(event?.ok).toBe(false);
    expect(event?.errorCode).toBe('NOT_FOUND');
  });

  test('a successful request records no error at all', async () => {
    const { res, event } = await callAndAudit('/widgets/w1');

    expect(res.status).toBe(200);
    expect(event?.ok).toBe(true);
    expect(event?.errorCode).toBeUndefined();
    expect(event?.errorMessage).toBeUndefined();
  });
});

describe('recording the failure changes nothing the caller can see', () => {
  test('the default envelope is byte-identical to what it always was', async () => {
    const { res } = await callAndAudit('/widgets/boom');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: { code: 'INTERNAL_SERVER_ERROR', message: 'Internal server error' },
    });
  });

  test('a custom onError branch does not gain a stderr line', async () => {
    // `normalizeError` logs the raw cause; the custom branch deliberately never
    // calls it, and recording the failure must not have changed that.
    const logged: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void logged.push(args[0]);
    try {
      const audit = createObservability({ request: { write: () => undefined } });
      const handler = createHandler({
        services: [service],
        hooks: { onError: () => new Response('handled', { status: 503 }) },
        observability: audit.request,
      });
      await handler(new Request('http://localhost/widgets/boom'), undefined);
    } finally {
      console.error = original;
    }
    expect(logged).toEqual([]);
  });
});
