/**
 * `createToolLogger` — a ready `afterToolCall` that logs each tool call and
 * feeds an optional metrics sink, keyed by the endpoint's identity.
 */
import { describe, expect, test } from 'bun:test';
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
    await hooks.afterToolCall?.(
      'list_widgets',
      {},
      { ok: true, data: [] },
      12.4,
      ctx,
      endpoint,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe('[tool] ok list_widgets (widgets.list) 12ms');
  });

  test('logs a failed call with the error code', async () => {
    const lines: string[] = [];
    const hooks = createToolLogger({ log: (l) => lines.push(l) });
    await hooks.afterToolCall?.('get_widget', {}, { ok: false, code: 'NOT_FOUND' }, 4, ctx, {
      ...endpoint,
      key: 'get',
      desc: 'Get a widget',
    });
    expect(lines[0]).toBe('[tool] warn get_widget (widgets.get) NOT_FOUND 4ms');
  });

  test('feeds onRecord the structured parts', async () => {
    const records: ToolCallRecord[] = [];
    const hooks = createToolLogger({ log: () => undefined, onRecord: (r) => records.push(r) });
    await hooks.afterToolCall?.(
      'list_widgets',
      {},
      { ok: true, data: [] },
      7.9,
      ctx,
      endpoint,
    );
    expect(records[0]).toEqual({
      tool: 'list_widgets',
      service: 'widgets',
      action: 'list',
      ok: true,
      code: undefined,
      durationMs: 8,
      source: 'mcp',
    });
  });
});
