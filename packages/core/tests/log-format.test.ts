/**
 * The built-in formatter writes what the consumer asked for. `format` decides;
 * `NODE_ENV` is only the default, and it is read per request — never at import
 * and never at this package's build, which would freeze the choice for everyone
 * who installs it.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineContract } from '../src/contract';
import { setRequestUser, wrapInRequestContext } from '../src/observability';
import { createHandler, implement } from '../src/server';
import { resolveLogFormat } from '../src/server/logger';

const ITEM = z.object({ id: z.string() });

function itemsService() {
  const contract = defineContract(
    { prefix: 'items' },
    { get: { method: 'GET', path: '/', desc: 'Get an item', output: ITEM } },
  );
  return implement(contract, {
    get: () => {
      setRequestUser('u-7');
      return { id: '1' };
    },
  });
}

/** Run `fn` with `console.log` captured. */
async function captured(fn: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => void lines.push(args.join(' '));
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines;
}

const originalNodeEnv = process.env.NODE_ENV;
afterEach(() => {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
});

describe('format: json', () => {
  test('writes one structured record per request, no arrival line', async () => {
    const handler = createHandler({
      services: [itemsService()],
      logging: { format: 'json', enrich: () => ({ mine: 'kept' }) },
    });

    const lines = await captured(() => handler(new Request('http://x/items')));

    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0] ?? '{}');
    expect(record).toMatchObject({
      level: 'info',
      method: 'GET',
      path: '/items',
      status: 200,
      mine: 'kept',
    });
    expect(record.traceId).toBeTruthy();
  });

  test('carries the request-context identity', async () => {
    const handler = wrapInRequestContext(
      createHandler({ services: [itemsService()], logging: { format: 'json' } }),
    );

    const lines = await captured(() => handler(new Request('http://x/items'), undefined));
    const record = JSON.parse(lines[0] ?? '{}');

    expect(record.userId).toBe('u-7');
    expect(record.serviceName).toBe('items');
    expect(record.action).toBe('get');
  });
});

describe('format: pretty', () => {
  test('writes an arrival and a completion line, and no extra fields', async () => {
    const handler = createHandler({
      services: [itemsService()],
      logging: { format: 'pretty', enrich: () => ({ mine: 'kept' }) },
    });

    const lines = await captured(() => handler(new Request('http://x/items')));

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('→');
    expect(lines[1]).toContain('←');
    expect(lines.join('\n')).not.toContain('mine');
  });
});

describe('the default follows the environment, at request time', () => {
  test('production yields json', async () => {
    process.env.NODE_ENV = 'production';
    const handler = createHandler({ services: [itemsService()], logging: true });

    const lines = await captured(() => handler(new Request('http://x/items')));

    expect(lines).toHaveLength(1);
    expect(() => JSON.parse(lines[0] ?? '')).not.toThrow();
  });

  test('anything else yields pretty', async () => {
    process.env.NODE_ENV = 'development';
    const handler = createHandler({ services: [itemsService()], logging: true });

    const lines = await captured(() => handler(new Request('http://x/items')));

    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('←');
  });

  test('one handler follows a change between requests — nothing is frozen', async () => {
    // The regression this guards: reading `NODE_ENV` at module scope let the
    // bundler fold it into a literal at *library* build time, so no consumer
    // could ever reach the structured line.
    const handler = createHandler({ services: [itemsService()], logging: true });

    process.env.NODE_ENV = 'development';
    const dev = await captured(() => handler(new Request('http://x/items')));
    process.env.NODE_ENV = 'production';
    const prod = await captured(() => handler(new Request('http://x/items')));

    expect(dev).toHaveLength(2);
    expect(prod).toHaveLength(1);
  });

  test('an explicit format ignores the environment entirely', async () => {
    process.env.NODE_ENV = 'production';
    const handler = createHandler({
      services: [itemsService()],
      logging: { format: 'pretty' },
    });

    const lines = await captured(() => handler(new Request('http://x/items')));
    expect(lines).toHaveLength(2);
  });

  test('resolveLogFormat states the rule on its own', () => {
    process.env.NODE_ENV = 'production';
    expect(resolveLogFormat()).toBe('json');
    expect(resolveLogFormat('pretty')).toBe('pretty');
    process.env.NODE_ENV = 'test';
    expect(resolveLogFormat()).toBe('pretty');
    expect(resolveLogFormat('json')).toBe('json');
  });
});

describe('a custom logger is not a format', () => {
  test('the sink receives structured fields whatever the environment', async () => {
    process.env.NODE_ENV = 'development';
    const rows: Array<Record<string, unknown>> = [];
    const push = (_m: string, fields?: Record<string, unknown>) => {
      if (fields) rows.push(fields);
    };
    const handler = createHandler({
      services: [itemsService()],
      logging: {
        logger: { info: push, warn: push, error: push, debug: push },
        enrich: () => ({ mine: 'kept' }),
      },
    });

    await handler(new Request('http://x/items'));

    const done = rows.find((r) => typeof r.status === 'number');
    expect(done?.mine).toBe('kept');
    expect(done?.status).toBe(200);
  });
});
