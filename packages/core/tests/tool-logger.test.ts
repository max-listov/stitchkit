/**
 * `createToolLogger` — a ready `afterToolCall` that logs each tool call and
 * feeds an optional metrics sink, keyed by the endpoint's identity.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { wrapInRequestContext } from '../src/observability';
import type { MethodDef } from '../src/server';
import { createToolLogger, type ToolCallRecord } from '../src/tools';

// A minimal MethodDef — the logger only reads `serviceName` / `key`.
const endpoint: MethodDef = {
  method: 'GET',
  path: '/',
  desc: 'List widgets',
  serviceName: 'widgets',
  key: 'list',
  handler: () => undefined,
};
const ctx = { source: 'mcp' as const };

describe('createToolLogger', () => {
  test('logs a successful call with identity and duration', async () => {
    const lines: string[] = [];
    const hooks = createToolLogger({ log: (l) => lines.push(l) });
    await hooks.afterToolCall?.({
      toolName: 'list_widgets',
      args: {},
      result: { ok: true, data: [] },
      durationMs: 12.4,
      context: ctx,
      endpoint,
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe('[tool] ok list_widgets (widgets.list) 12ms');
  });

  test('the DEFAULT sink writes to stderr, never stdout (stdio JSON-RPC channel)', async () => {
    // `createStdioMcpServer({ hooks: createToolLogger() })` is a valid setup —
    // a default line on stdout would corrupt the protocol stream.
    const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined);
    const infoSpy = spyOn(console, 'info').mockImplementation(() => undefined);
    const logSpy = spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const hooks = createToolLogger();
      await hooks.afterToolCall?.({
        toolName: 'list_widgets',
        args: {},
        result: { ok: true, data: [] },
        durationMs: 1,
        context: ctx,
        endpoint,
      });
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(infoSpy).not.toHaveBeenCalled();
      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
      infoSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  test('logs a failed call with the error code', async () => {
    const lines: string[] = [];
    const hooks = createToolLogger({ log: (l) => lines.push(l) });
    await hooks.afterToolCall?.({
      toolName: 'get_widget',
      args: {},
      result: { ok: false, code: 'NOT_FOUND' },
      durationMs: 4,
      context: ctx,
      endpoint: { ...endpoint, key: 'get', desc: 'Get a widget' },
    });
    expect(lines[0]).toBe('[tool] warn get_widget (widgets.get) NOT_FOUND 4ms');
  });

  test('feeds onRecord the structured parts', async () => {
    const records: ToolCallRecord[] = [];
    const hooks = createToolLogger({ log: () => undefined, onRecord: (r) => records.push(r) });
    await hooks.afterToolCall?.({
      toolName: 'list_widgets',
      args: {},
      result: { ok: true, data: [] },
      durationMs: 7.9,
      context: ctx,
      endpoint,
    });
    expect(records[0]).toEqual({
      tool: 'list_widgets',
      service: 'widgets',
      action: 'list',
      ok: true,
      code: undefined,
      durationMs: 8,
      source: 'mcp',
      traceId: undefined,
    });
  });

  test('carries the active trace id, so the call joins its HTTP request', async () => {
    const records: ToolCallRecord[] = [];
    const hooks = createToolLogger({ log: () => undefined, onRecord: (r) => records.push(r) });
    const call = () =>
      hooks.afterToolCall?.({
        toolName: 'list_widgets',
        args: {},
        result: { ok: true, data: [] },
        durationMs: 1,
        context: ctx,
        endpoint,
      });

    await wrapInRequestContext(async () => {
      await call();
      return new Response(null);
    })(new Request('http://x/'), undefined);

    // Outside a context there is nothing to join to, and the field is absent.
    await call();

    expect(records[0]?.traceId).toBeTruthy();
    expect(records[1]?.traceId).toBeUndefined();
  });
});
