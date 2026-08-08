import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineContract } from '../src/contract';
import { createObservability, type RequestEvent } from '../src/observability';
import { createHandler, implement, type StitchLogger } from '../src/server';

const contract = defineContract(
  { prefix: 'items' },
  {
    create: {
      method: 'POST',
      path: '/',
      desc: 'Create item',
      input: z.object({ name: z.string() }),
      output: z.object({ name: z.string() }),
    },
  },
);

const service = implement(contract, {
  create: ({ input }) => ({ name: input.name }),
});

class CloneProbeRequest extends Request {
  clones = 0;

  override clone(): Request {
    this.clones += 1;
    return super.clone();
  }
}

interface CompletionLog {
  durationMs: number;
  traceId: string;
}

function recordingLogger(rows: CompletionLog[]): StitchLogger {
  const write = (_message: string, fields?: Record<string, unknown>) => {
    if (typeof fields?.status !== 'number') return;
    if (typeof fields.durationMs !== 'number' || typeof fields.traceId !== 'string') {
      throw new Error('Expected typed HTTP completion fields');
    }
    rows.push({ durationMs: fields.durationMs, traceId: fields.traceId });
  };
  return { debug: write, info: write, warn: write, error: write };
}

describe('unified HTTP observability', () => {
  test('payload-off creates no request clone and shares one completion with logging', async () => {
    const events: RequestEvent[] = [];
    const logs: CompletionLog[] = [];
    const observability = createObservability({
      request: { write: (event) => void events.push(event) },
    });
    const handler = createHandler({
      services: [service],
      logging: { logger: recordingLogger(logs) },
      observability: observability.request,
    });
    const request = new CloneProbeRequest('http://localhost/items', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'one' }),
    });

    const response = await handler(request);
    await Bun.sleep(10);

    expect(response.status).toBe(200);
    expect(request.clones).toBe(0);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toBeNull();
    expect(logs).toHaveLength(1);
    expect(events[0]?.durationMs).toBe(logs[0]?.durationMs);
    expect(events[0]?.traceId).toBe(logs[0]?.traceId);
  });

  test('payload-on clones once and records the sanitized JSON body', async () => {
    const events: RequestEvent[] = [];
    const observability = createObservability({
      request: {
        write: (event) => void events.push(event),
        includePayload: true,
      },
    });
    const handler = createHandler({
      services: [service],
      observability: observability.request,
    });
    const request = new CloneProbeRequest('http://localhost/items', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'two', token: 'secret' }),
    });

    const response = await handler(request);
    await Bun.sleep(10);

    expect(response.status).toBe(200);
    expect(request.clones).toBe(1);
    expect(events[0]?.payload).toEqual({ name: 'two', token: '[redacted]' });
  });

  test('request and logging sinks fail independently', async () => {
    const logs: CompletionLog[] = [];
    const observability = createObservability({
      request: {
        write: () => {
          throw new Error('audit unavailable');
        },
      },
    });
    const handler = createHandler({
      services: [service],
      logging: { logger: recordingLogger(logs) },
      observability: observability.request,
    });

    const response = await handler(
      new Request('http://localhost/items', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'three' }),
      }),
    );
    await Bun.sleep(10);

    expect(response.status).toBe(200);
    expect(logs).toHaveLength(1);
  });
});
