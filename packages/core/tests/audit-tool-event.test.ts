import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineContract } from '../src/contract';
import { createObservability, type RequestEvent } from '../src/observability';
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
    const audit = createObservability({ tools: { write: (e) => void events.push(e) } });

    audit.toolCall.afterToolCall?.({
      toolName: 'broadcast_create',
      args: { name: 'x' },
      result: { ok: true, data: { id: 'x' } },
      durationMs: 5,
      context: { source: 'agent' },
      endpoint,
    });
    await Bun.sleep(5);

    const e = events[0];
    expect(e?.method).toBe('TOOL');
    // The verb a single read/write filter spans HTTP + tools by.
    expect(e?.httpMethod).toBe('POST');
    expect(e?.serviceName).toBe('broadcast');
    expect(e?.action).toBe('create');
    expect(e?.outcome).toBeUndefined();
  });

  test('MCP protocol cancellation stays nested and does not impersonate HTTP cancellation', async () => {
    const events: RequestEvent[] = [];
    const audit = createObservability({ tools: { write: (e) => void events.push(e) } });

    audit.toolCall.afterToolCall?.({
      toolName: 'broadcast_create',
      args: { name: 'x' },
      result: { ok: false, code: 'REQUEST_ABORTED' },
      durationMs: 5,
      context: {
        source: 'mcp',
        mcp: {
          era: 'modern',
          method: 'tools/call',
          toolName: 'broadcast_create',
          outcome: 'cancelled',
        },
      },
      endpoint,
    });
    await audit.flush();

    expect(events[0]?.mcp?.outcome).toBe('cancelled');
    expect(events[0]?.outcome).toBeUndefined();
  });

  test('a failed tool call carries structured errorDetail', async () => {
    const events: RequestEvent[] = [];
    const audit = createObservability({ tools: { write: (e) => void events.push(e) } });

    audit.toolCall.afterToolCall?.({
      toolName: 'broadcast_create',
      args: { bad: 1 },
      result: {
        ok: false,
        code: 'VALIDATION_ERROR',
        details: { issues: [{ path: 'name', message: 'Required' }] },
      },
      durationMs: 3,
      context: { source: 'agent' },
      endpoint,
    });
    await Bun.sleep(5);

    const e = events[0];
    expect(e?.ok).toBe(false);
    expect(e?.errorCode).toBe('VALIDATION_ERROR');
    expect(e?.errorDetail).toEqual({ issues: [{ path: 'name', message: 'Required' }] });
  });
});

describe('audit — the tool row names the cause of an unexpected throw', () => {
  test('the scrubbed message is replaced by the real one', async () => {
    const events: RequestEvent[] = [];
    const audit = createObservability({ tools: { write: (e) => void events.push(e) } });

    audit.toolCall.afterToolCall?.({
      toolName: 'broadcast_create',
      args: { name: 'x' },
      // What the caller was told, and all the row used to have.
      result: {
        ok: false,
        code: 'INTERNAL_SERVER_ERROR',
        details: { message: 'Internal server error' },
      },
      durationMs: 7,
      context: { source: 'agent' },
      endpoint,
      error: new Error('ECONNREFUSED 10.0.0.4:5432'),
    });
    await Bun.sleep(5);

    const e = events[0];
    expect(e?.errorCode).toBe('INTERNAL_SERVER_ERROR');
    expect(e?.errorMessage).toBe('ECONNREFUSED 10.0.0.4:5432');
    // The code stays the contract's; only the message gains information.
    expect(e?.errorDetail).toEqual({ message: 'Internal server error' });
  });

  test('a thrown string is taken as the message', async () => {
    const events: RequestEvent[] = [];
    const audit = createObservability({ tools: { write: (e) => void events.push(e) } });

    audit.toolCall.afterToolCall?.({
      toolName: 'broadcast_create',
      args: {},
      result: {
        ok: false,
        code: 'INTERNAL_SERVER_ERROR',
        details: { message: 'Internal server error' },
      },
      durationMs: 2,
      context: { source: 'agent' },
      endpoint,
      error: 'worker pool exhausted',
    });
    await Bun.sleep(5);

    expect(events[0]?.errorMessage).toBe('worker pool exhausted');
  });

  test('a truthful envelope is left alone — an AppError keeps its own message', async () => {
    const events: RequestEvent[] = [];
    const audit = createObservability({ tools: { write: (e) => void events.push(e) } });

    audit.toolCall.afterToolCall?.({
      toolName: 'broadcast_create',
      args: {},
      result: { ok: false, code: 'NOT_FOUND', details: { message: 'No such broadcast' } },
      durationMs: 2,
      context: { source: 'agent' },
      endpoint,
      error: new Error('No such broadcast'),
    });
    await Bun.sleep(5);

    expect(events[0]?.errorMessage).toBe('No such broadcast');
  });

  test('without a raw error the row is exactly what it was', async () => {
    const events: RequestEvent[] = [];
    const audit = createObservability({ tools: { write: (e) => void events.push(e) } });

    audit.toolCall.afterToolCall?.({
      toolName: 'broadcast_create',
      args: {},
      result: {
        ok: false,
        code: 'INTERNAL_SERVER_ERROR',
        details: { message: 'Internal server error' },
      },
      durationMs: 2,
      context: { source: 'agent' },
      endpoint,
    });
    await Bun.sleep(5);

    expect(events[0]?.errorMessage).toBe('Internal server error');
  });
});

describe('audit — observation cannot change a tool result', () => {
  test('bigint and circular results still produce a successful audit row', async () => {
    const events: RequestEvent[] = [];
    const audit = createObservability({
      tools: { write: (event) => void events.push(event) },
    });
    const circular: { self?: unknown } = {};
    circular.self = circular;

    expect(() =>
      audit.toolCall.afterToolCall?.({
        toolName: 'broadcast_create',
        args: { total: 10n },
        result: { ok: true, data: { total: 10n, circular } },
        durationMs: 1,
        context: { source: 'agent' },
        endpoint,
      }),
    ).not.toThrow();
    await Bun.sleep(5);

    expect(events).toHaveLength(1);
    expect(events[0]?.ok).toBe(true);
    expect(events[0]?.responseBytes).toBe(0);
    expect(events[0]?.payload).toEqual({ total: '10' });
  });

  test('an unreadable argument is marked without breaking or dropping the row', async () => {
    const events: RequestEvent[] = [];
    const audit = createObservability({
      tools: { write: (event) => void events.push(event) },
    });
    const args = Object.create(null);
    Object.defineProperty(args, 'value', {
      enumerable: true,
      get() {
        throw new Error('nope');
      },
    });

    expect(() =>
      audit.toolCall.afterToolCall?.({
        toolName: 'broadcast_create',
        args,
        result: { ok: true, data: { id: 'x' } },
        durationMs: 1,
        context: { source: 'agent' },
        endpoint,
      }),
    ).not.toThrow();
    await Bun.sleep(5);

    expect(events[0]?.payload).toEqual({ value: '[unreadable]' });
  });

  test('a throwing sink is swallowed', async () => {
    const audit = createObservability({
      tools: {
        write: () => {
          throw new Error('sink down');
        },
      },
    });

    expect(() =>
      audit.toolCall.afterToolCall?.({
        toolName: 'broadcast_create',
        args: {},
        result: { ok: true, data: { id: 'x' } },
        durationMs: 1,
        context: { source: 'agent' },
        endpoint,
      }),
    ).not.toThrow();
    await Bun.sleep(5);
  });
});
