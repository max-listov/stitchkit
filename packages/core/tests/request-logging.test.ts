/**
 * Request logging as a configurable surface: `logging` is a config object,
 * `skip` silences chosen requests, `enrich` adds fields, and the line picks up
 * the active observability context for free. Plus the invariants that make all
 * of that safe — one line per request, and a sink that throws never reaches the
 * caller.
 */

import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineContract } from '../src/contract';
import { serveNode } from '../src/node';
import {
  createObservability,
  getTraceId,
  setRequestDimensions,
  setRequestUser,
  wrapInRequestContext,
} from '../src/observability';
import type { LoggingConfig, RawRoute, StitchLogger } from '../src/server';
import {
  createHandler,
  createServer,
  DEFAULT_CORS_EXPOSE_HEADERS,
  implement,
} from '../src/server';
import { structuredLine } from '../src/server/logger';

interface Line {
  msg: string;
  fields: Record<string, unknown>;
}

/** A logger that records every level into one list. */
function recordingLogger(lines: Line[]): StitchLogger {
  const push = (msg: string, fields?: Record<string, unknown>) => {
    lines.push({ msg, fields: fields ?? {} });
  };
  return { info: push, warn: push, error: push, debug: push };
}

/** Completion lines only — the incoming `debug` breadcrumb is not one. */
function completions(lines: Line[]): Line[] {
  return lines.filter((l) => typeof l.fields.status === 'number');
}

const ITEM = z.object({ id: z.string() });

function itemsService() {
  const contract = defineContract(
    { prefix: 'items' },
    {
      get: { method: 'GET', path: '/', desc: 'Get an item', output: ITEM },
      create: {
        method: 'POST',
        path: '/',
        desc: 'Create an item',
        input: z.object({ id: z.string() }),
        output: ITEM,
      },
    },
  );
  return implement(contract, {
    get: () => ({ id: '1' }),
    create: ({ input }) => ({ id: input.id }),
  });
}

function handlerWith(logging: boolean | LoggingConfig) {
  return createHandler({ services: [itemsService()], logging });
}

describe('logging config — shape and semantics', () => {
  test('`true` is shorthand for `{}`: an empty object still logs', async () => {
    const lines: Line[] = [];
    // With no `logger` the built-in formatter writes, so assert through the
    // console rather than a sink.
    const original = console.log;
    const written: string[] = [];
    console.log = (...args: unknown[]) => void written.push(args.join(' '));
    try {
      const handler = createHandler({ services: [itemsService()], logging: {} });
      await handler(new Request('http://x/items'));
    } finally {
      console.log = original;
    }
    expect(written.some((l) => l.includes('/items'))).toBe(true);
    expect(lines).toEqual([]);
  });

  test('an object with only `skip` still logs — it is not "off"', async () => {
    const lines: Line[] = [];
    const handler = handlerWith({
      logger: recordingLogger(lines),
      skip: (_req, url) => url.pathname === '/health',
    });
    await handler(new Request('http://x/items'));
    expect(completions(lines)).toHaveLength(1);
  });

  test('`logging: false` stays off', async () => {
    // Observed where the output actually goes. With no `logger` the built-in
    // formatter writes to the console, so that is the only place emptiness can
    // be seen — the earlier version declared a `lines` sink, never wired it to
    // the handler, and asserted it was empty, which is true of every possible
    // implementation including one that logs every request.
    const original = console.log;
    const written: string[] = [];
    console.log = (...args: unknown[]) => void written.push(args.join(' '));
    try {
      await handlerWith(false)(new Request('http://x/items'));
      expect(written).toEqual([]);

      // The control: the same request under `logging: {}` DOES write, so the
      // emptiness above is the setting rather than the observation point.
      await handlerWith({})(new Request('http://x/items'));
      expect(written.some((line) => line.includes('/items'))).toBe(true);
    } finally {
      console.log = original;
    }
  });

  test('a typed StitchLogger is rejected by the compiler, not at runtime', () => {
    const lines: Line[] = [];
    const logger = recordingLogger(lines);
    // @ts-expect-error the pre-0.28 shape — weak-type detection catches it,
    // which is why the migration is loud for anyone whose logger has a type.
    expect(() => createHandler({ services: [itemsService()], logging: logger })).toThrow();
  });

  test('an untyped bare logger is refused at boot with the migration line', () => {
    // The one case the compiler cannot catch: a logger the type system does not
    // know — an `any`-typed import, a wrapped `pino`, a JavaScript consumer.
    // Structurally it is a valid `LoggingConfig` (every field optional), so
    // without this guard the app would boot having silently stopped logging.
    const untyped = JSON.parse('{}');
    const noop = (): undefined => undefined;
    untyped.info = noop;
    untyped.warn = noop;
    untyped.error = noop;
    untyped.debug = noop;

    expect(() => createHandler({ services: [itemsService()], logging: untyped })).toThrow(
      /logging: \{ logger: myLogger \}/,
    );
  });
});

describe('skip', () => {
  test('silences the chosen request and leaves others alone', async () => {
    const lines: Line[] = [];
    const handler = handlerWith({
      logger: recordingLogger(lines),
      skip: (_req, url) => url.pathname.startsWith('/items'),
    });
    await handler(new Request('http://x/items'));
    expect(lines).toEqual([]);

    await handler(new Request('http://x/nope'));
    expect(completions(lines)).toHaveLength(1);
  });

  test('cannot un-skip what the built-in filter already drops', async () => {
    const lines: Line[] = [];
    const handler = handlerWith({ logger: recordingLogger(lines), skip: () => false });
    await handler(new Request('http://x/favicon.ico'));
    expect(lines).toEqual([]);
  });

  test('a throwing skip does not fail the request and does not skip', async () => {
    const lines: Line[] = [];
    const handler = handlerWith({
      logger: recordingLogger(lines),
      skip: () => {
        throw new Error('boom');
      },
    });
    const res = await handler(new Request('http://x/items'));
    expect(res.status).toBe(200);
    expect(completions(lines)).toHaveLength(1);
  });
});

describe('enrich', () => {
  test('adds fields to the completion line, and only to it', async () => {
    const lines: Line[] = [];
    const handler = handlerWith({
      logger: recordingLogger(lines),
      enrich: (req) => ({ userAgent: req.headers.get('user-agent') ?? undefined }),
    });
    await handler(new Request('http://x/items', { headers: { 'user-agent': 'probe/1' } }));

    const done = completions(lines);
    expect(done).toHaveLength(1);
    expect(done[0]?.fields.userAgent).toBe('probe/1');
    // The incoming breadcrumb is untouched.
    const breadcrumb = lines.find((l) => typeof l.fields.status !== 'number');
    expect(breadcrumb?.fields.userAgent).toBeUndefined();
  });

  test('receives the outcome and cannot overwrite a framework field', async () => {
    const lines: Line[] = [];
    const seen: Array<{ status: number; errorCode?: string }> = [];
    const handler = handlerWith({
      logger: recordingLogger(lines),
      enrich: (_req, _url, outcome) => {
        seen.push({ status: outcome.status, errorCode: outcome.errorCode });
        return { status: 'hijacked', traceId: 'hijacked', mine: 'kept' };
      },
    });
    await handler(new Request('http://x/items'));

    const done = completions(lines)[0];
    expect(seen[0]?.status).toBe(200);
    expect(done?.fields.status).toBe(200);
    expect(done?.fields.traceId).not.toBe('hijacked');
    expect(done?.fields.mine).toBe('kept');
  });

  test('cannot forge the fields that are absent on a success', async () => {
    const lines: Line[] = [];
    // `errorCode` has no value on a 200 and `ip` none without a socket peer —
    // a conditional key would let `enrich` supply one and forge the record.
    const handler = handlerWith({
      logger: recordingLogger(lines),
      enrich: () => ({ errorCode: 'FORGED', ip: 'FORGED' }),
    });
    await handler(new Request('http://x/items'));

    const done = completions(lines)[0];
    expect(done?.fields.errorCode).toBeUndefined();
    expect(done?.fields.ip).toBeUndefined();
  });

  test('can describe a raw error Response when the framework derived no code', async () => {
    const lines: Line[] = [];
    const handler = createHandler({
      rawRoutes: [
        {
          method: 'GET',
          path: '/raw-failure',
          handler: () => new Response('down', { status: 503 }),
        },
      ],
      logging: {
        logger: recordingLogger(lines),
        enrich: () => ({ errorCode: 'UPSTREAM_UNAVAILABLE' }),
      },
    });

    const response = await handler(new Request('http://x/raw-failure'));

    expect(response.status).toBe(503);
    expect(completions(lines)[0]?.fields.errorCode).toBe('UPSTREAM_UNAVAILABLE');
  });

  test('cannot forge an error code on either a 2xx or 3xx response', async () => {
    const lines: Line[] = [];
    const handler = createHandler({
      rawRoutes: [
        { method: 'GET', path: '/ok', handler: () => new Response(null, { status: 204 }) },
        {
          method: 'GET',
          path: '/cached',
          handler: () => new Response(null, { status: 304 }),
        },
      ],
      logging: {
        logger: recordingLogger(lines),
        enrich: () => ({ errorCode: 'FORGED' }),
      },
    });

    await handler(new Request('http://x/ok'));
    await handler(new Request('http://x/cached'));

    expect(completions(lines).map((line) => line.fields.errorCode)).toEqual([
      undefined,
      undefined,
    ]);
  });

  test('keeps a framework-derived error code over enrichment', async () => {
    const lines: Line[] = [];
    const handler = handlerWith({
      logger: recordingLogger(lines),
      enrich: () => ({ errorCode: 'FORGED' }),
    });

    await handler(new Request('http://x/missing'));

    expect(completions(lines)[0]?.fields.errorCode).toBe('NOT_FOUND');
  });

  test('built-in JSON and a custom logger agree on the raw error code', async () => {
    const rawRoutes: RawRoute[] = [
      {
        method: 'GET',
        path: '/raw-failure',
        handler: () => new Response('down', { status: 503 }),
      },
    ];
    const enrich = () => ({ errorCode: 'UPSTREAM_UNAVAILABLE' });
    const customLines: Line[] = [];
    const custom = createHandler({
      rawRoutes,
      logging: { logger: recordingLogger(customLines), enrich },
    });
    await custom(new Request('http://x/raw-failure'));

    const written: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => void written.push(args.join(' '));
    try {
      const builtIn = createHandler({ rawRoutes, logging: { format: 'json', enrich } });
      await builtIn(new Request('http://x/raw-failure'));
    } finally {
      console.log = original;
    }

    const builtInFields = JSON.parse(written[0] ?? '{}');
    expect(builtInFields.errorCode).toBe('UPSTREAM_UNAVAILABLE');
    expect(completions(customLines)[0]?.fields.errorCode).toBe(builtInFields.errorCode);
  });

  test('warns once per handler for each discarded owned enrichment key', async () => {
    const lines: Line[] = [];
    const handler = handlerWith({
      logger: recordingLogger(lines),
      enrich: () => ({ status: 'FORGED', traceId: 'FORGED' }),
    });

    await handler(new Request('http://x/items'));
    await handler(new Request('http://x/items'));

    const warnings = lines.filter((line) => line.msg.includes('was discarded'));
    expect(warnings.map((line) => line.msg)).toEqual([
      '[stitchkit] logging.enrich field "status" was discarded because the framework owns it',
      '[stitchkit] logging.enrich field "traceId" was discarded because the framework owns it',
    ]);
  });

  test('a throwing enrich still leaves the line written', async () => {
    const lines: Line[] = [];
    const handler = handlerWith({
      logger: recordingLogger(lines),
      enrich: () => {
        throw new Error('boom');
      },
    });
    const res = await handler(new Request('http://x/items'));
    expect(res.status).toBe(200);
    expect(completions(lines)).toHaveLength(1);
  });
});

describe('the line picks up the request context', () => {
  test('carries identity, user and nested dimensions when a context is active', async () => {
    const lines: Line[] = [];
    const inner = createHandler({
      services: [
        implement(
          defineContract(
            { prefix: 'items' },
            { get: { method: 'GET', path: '/', desc: 'Get an item', output: ITEM } },
          ),
          {
            get: () => {
              setRequestUser('u-7');
              setRequestDimensions({ projectId: 'p-1' });
              return { id: '1' };
            },
          },
        ),
      ],
      logging: { logger: recordingLogger(lines) },
    });
    const handler = wrapInRequestContext(inner);
    await handler(new Request('http://x/items'), undefined);

    const done = completions(lines)[0];
    expect(done?.fields.userId).toBe('u-7');
    expect(done?.fields.serviceName).toBe('items');
    expect(done?.fields.action).toBe('get');
    // Nested, never spread — an app dimension must not collide with `path`.
    expect(done?.fields.dimensions).toEqual({ projectId: 'p-1' });
  });

  test('endpoint identity survives a validation failure', async () => {
    const lines: Line[] = [];
    const inner = handlerWith({ logger: recordingLogger(lines) });
    const handler = wrapInRequestContext(inner);
    const res = await handler(
      new Request('http://x/items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wrong: 'field' }),
      }),
      undefined,
    );
    expect(res.status).toBe(400);

    const done = completions(lines)[0];
    expect(done?.fields.status).toBe(400);
    expect(done?.fields.serviceName).toBe('items');
    expect(done?.fields.action).toBe('create');
  });

  test('degrades silently when nothing established a context', async () => {
    const lines: Line[] = [];
    const handler = handlerWith({ logger: recordingLogger(lines) });
    await handler(new Request('http://x/items'));

    const done = completions(lines)[0];
    expect(done?.fields.userId).toBeUndefined();
    expect(done?.fields.dimensions).toBeUndefined();
    expect(done?.fields.traceId).toBeDefined();
  });
});

describe('the log path cannot break the request', () => {
  test('a throwing sink neither escapes nor logs twice', async () => {
    let calls = 0;
    // Every level throws, `debug` included — the incoming breadcrumb runs
    // before the timing window and is the easiest place for a throw to escape.
    const down = () => {
      calls += 1;
      throw new Error('sink down');
    };
    const throwing: StitchLogger = { info: down, warn: down, error: down, debug: down };
    const handler = createHandler({
      services: [itemsService()],
      logging: { logger: throwing },
    });
    const res = await handler(new Request('http://x/items'));
    expect(res.status).toBe(200);
    // Once for the breadcrumb, once for the completion line — both swallowed.
    expect(calls).toBe(2);
  });

  test('a diagnostic sink that throws cannot turn a 200 into a 500', async () => {
    const contract = defineContract(
      { prefix: 'notes' },
      {
        get: {
          method: 'GET',
          path: '/',
          desc: 'Get a note',
          output: z.object({ id: z.string() }),
        },
      },
    );
    const noop = (): undefined => undefined;
    const handler = createHandler({
      // The handler returns more than the contract declares, so the
      // output-strip diagnostic fires — on the success path.
      services: [implement(contract, { get: () => ({ id: '1', secret: 'x' }) })],
      warnOnOutputStrip: true,
      logging: {
        logger: {
          info: noop,
          error: noop,
          debug: noop,
          warn: () => {
            throw new Error('sink down');
          },
        },
      },
    });
    const res = await handler(new Request('http://x/notes'));
    expect(res.status).toBe(200);
  });

  test('an unserialisable result logs one line, and it is the error', async () => {
    const lines: Line[] = [];
    const contract = defineContract(
      { prefix: 'bad' },
      { get: { method: 'GET', path: '/', desc: 'Unserialisable', output: z.unknown() } },
    );
    const handler = createHandler({
      // `Response.json` throws on a BigInt — the throw belongs to the error
      // path, and the caller must never see a logged 200 it did not receive.
      services: [implement(contract, { get: () => ({ n: BigInt(1) }) })],
      logging: { logger: recordingLogger(lines) },
    });
    const res = await handler(new Request('http://x/bad'));

    const done = completions(lines);
    expect(done).toHaveLength(1);
    expect(done[0]?.fields.status).toBe(res.status);
    expect(res.status).toBeGreaterThanOrEqual(500);
  });
});

describe('composition seam', () => {
  test('createServer emits request observability without an outer wrapper', async () => {
    const events: Array<{ userAgent?: string; path: string }> = [];
    const observability = createObservability({
      request: {
        write: (event) => void events.push({ userAgent: event.userAgent, path: event.path }),
      },
    });
    const server = createServer({
      services: [itemsService()],
      port: 0,
      observability: observability.request,
    });
    try {
      const res = await fetch(`http://localhost:${server.port}/items`, {
        headers: { 'user-agent': 'probe/2' },
      });
      expect(res.status).toBe(200);
      // The audit sink is fire-and-forget; give it the microtask it needs.
      await Bun.sleep(20);
      expect(events).toHaveLength(1);
      expect(events[0]?.userAgent).toBe('probe/2');
      expect(events[0]?.path).toBe('/items');
    } finally {
      await server.shutdown({ gracePeriodMs: 0 });
    }
  });

  test('serveNode composes the same way', async () => {
    const traceIds: Array<string | undefined> = [];
    const server = await serveNode({
      services: [itemsService()],
      port: 0,
      // The Node path destructures `wrapFetch` out of the handler config — a
      // rename there would drop the wrapper silently, so assert it end to end.
      wrapFetch: (handler) => wrapInRequestContext(handler),
      logging: {
        enrich: () => {
          traceIds.push(getTraceId());
          return undefined;
        },
      },
    });
    try {
      const res = await fetch(`${server.url}/items`);
      expect(res.status).toBe(200);
      // A context existed inside the request, which only the wrapper can do.
      expect(traceIds).toHaveLength(1);
      expect(traceIds[0]).toBeTruthy();
    } finally {
      await server.shutdown({ gracePeriodMs: 0 });
    }
  });
});

describe('a structured line survives an unserialisable extra field', () => {
  test('the framework fields are re-emitted alone rather than lost', () => {
    const own = { status: 200, traceId: 't-1' };
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(JSON.parse(structuredLine(own, { mine: 'kept' }))).toEqual({
      mine: 'kept',
      status: 200,
      traceId: 't-1',
    });
    // The cycle costs the extra fields, never the record.
    expect(JSON.parse(structuredLine(own, cyclic))).toEqual(own);
  });
});

describe('the trace id is readable', () => {
  test('the response carries x-request-id and the default expose list names it', async () => {
    const handler = createHandler({ services: [itemsService()] });
    const res = await handler(new Request('http://x/items'));
    expect(res.headers.get('x-request-id')).toBeTruthy();

    expect(DEFAULT_CORS_EXPOSE_HEADERS).toContain('X-Request-Id');
    // The header the server never sent must not be advertised as readable.
    expect(DEFAULT_CORS_EXPOSE_HEADERS).not.toContain('X-Trace-Id');
  });

  test('getTraceId is accepted as the resolver — the documented snippet compiles', async () => {
    // Pinned in a compiled file on purpose: the guide has shown this line for
    // a long time while the option demanded `string`, so it never typechecked.
    const handler = createHandler({ services: [itemsService()], traceId: getTraceId });
    const res = await wrapInRequestContext(handler)(new Request('http://x/items'), undefined);
    expect(res.headers.get('x-request-id')).toBeTruthy();
  });

  test('a resolver returning undefined falls back instead of stamping "undefined"', async () => {
    const handler = createHandler({
      services: [itemsService()],
      // Exactly the shape of `getTraceId` outside an active context.
      traceId: () => undefined,
    });
    const res = await handler(new Request('http://x/items'));
    expect(res.headers.get('x-request-id')).toBeTruthy();
    expect(res.headers.get('x-request-id')).not.toBe('undefined');
  });
});
