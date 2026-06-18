import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineContract } from '../src/contract';
import { createAuditHook, type RequestEvent } from '../src/observability';
import { implement } from '../src/server';

const broadcast = defineContract(
  { prefix: 'broadcast' },
  {
    create: {
      method: 'POST',
      path: '/',
      desc: 'Create a broadcast',
      input: z.object({ name: z.string() }),
      output: z.object({ id: z.string() }),
      expose: ['MCP', 'AGENT'],
    },
  },
);

const service = implement(broadcast, { create: (ctx) => ({ id: ctx.input.name }) });
const endpoint = service.methods.create;
if (!endpoint) throw new Error('test setup: missing endpoint');

describe('audit — tool RequestEvent verb (A/#2) + errorDetail (#5)', () => {
  test('a tool event carries the contract verb in httpMethod, alongside service/action', async () => {
    const events: RequestEvent[] = [];
    const audit = createAuditHook({ write: (e) => void events.push(e) });

    audit.toolCall.afterToolCall?.(
      'broadcast_create',
      { name: 'x' },
      { ok: true, data: { id: 'x' } },
      5,
      { source: 'agent' },
      endpoint,
    );
    await Bun.sleep(5);

    const e = events[0];
    expect(e?.method).toBe('TOOL');
    // The verb a single read/write filter spans HTTP + tools by.
    expect(e?.httpMethod).toBe('POST');
    expect(e?.serviceName).toBe('broadcast');
    expect(e?.action).toBe('create');
  });

  test('a failed tool call carries structured errorDetail', async () => {
    const events: RequestEvent[] = [];
    const audit = createAuditHook({ write: (e) => void events.push(e) });

    audit.toolCall.afterToolCall?.(
      'broadcast_create',
      { bad: 1 },
      {
        ok: false,
        code: 'VALIDATION_ERROR',
        details: { issues: [{ path: 'name', message: 'Required' }] },
      },
      3,
      { source: 'agent' },
      endpoint,
    );
    await Bun.sleep(5);

    const e = events[0];
    expect(e?.ok).toBe(false);
    expect(e?.errorCode).toBe('VALIDATION_ERROR');
    expect(e?.errorDetail).toEqual({ issues: [{ path: 'name', message: 'Required' }] });
  });
});
