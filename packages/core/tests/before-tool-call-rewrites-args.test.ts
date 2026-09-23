import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import type { MethodDef } from '../src/server/types';
import {
  type AfterToolCallOptions,
  executeToolMethod,
  type ToolArgumentExtension,
} from '../src/tools/execute';

/*
 * The pipeline was asymmetric, and the asymmetry had a cost.
 *
 * `lifecycle.afterHandle` could already transform the OUTPUT. The input could only be REFUSED:
 * `beforeToolCall` saw the raw arguments and its return value was dropped on the floor, while
 * `lifecycle.beforeHandle` runs after the schemas have already said no. A consumer wanting to
 * expand "the id of the previous call's result" into the id itself — so a fabricated id is caught
 * before the side effect rather than after — had nowhere to stand, and closed the feature rather
 * than introduce a second way to pass an argument.
 */

function method(
  overrides: Partial<MethodDef<unknown, unknown, unknown>> = {},
): MethodDef<unknown, unknown, unknown> {
  return {
    method: 'POST',
    path: '/',
    serviceName: 'journal',
    key: 'record',
    desc: 'Record one entry',
    inputSchema: z.object({ id: z.string() }),
    outputSchema: z.object({ seen: z.string() }),
    handler: (ctx) => ({ seen: (ctx.input as { id: string }).id }),
    ...overrides,
  };
}

describe('beforeToolCall can replace the arguments it is shown', () => {
  test('a returned record becomes the arguments the handler runs on', async () => {
    const result = await executeToolMethod(
      method(),
      {
        toolName: 'record_journal',
        rawArgs: { id: '@previous' },
        context: { source: 'agent' },
      },
      { hooks: { beforeToolCall: ({ args }) => ({ ...args, id: 'resolved-42' }) } },
    );
    expect(result).toEqual({ ok: true, data: { seen: 'resolved-42' } });
  });

  test('the replacement is validated, not trusted', async () => {
    // The point of rewriting BEFORE the schema is that the schema still runs. A hook
    // returning something the contract refuses must produce an ordinary refusal, not an
    // exception escaping the call.
    const result = await executeToolMethod(
      method(),
      {
        toolName: 'record_journal',
        rawArgs: { id: '@previous' },
        context: { source: 'agent' },
      },
      { hooks: { beforeToolCall: () => ({ id: 42 }) } },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('VALIDATION_ERROR');
  });

  test('returning nothing leaves the arguments exactly as they arrived', async () => {
    for (const returned of [undefined, null]) {
      const result = await executeToolMethod(
        method(),
        {
          toolName: 'record_journal',
          rawArgs: { id: 'untouched' },
          context: { source: 'agent' },
        },
        { hooks: { beforeToolCall: () => returned } },
      );
      expect(result).toEqual({ ok: true, data: { seen: 'untouched' } });
    }
  });

  test('what existing hooks already return keeps meaning "unchanged"', async () => {
    // A one-line hook returns whatever its expression returns: the Map from
    // `audit.set(...)`, the number from `push(...)`, a string. Every one of those
    // was ignored yesterday and must be ignored today — `Object.entries(new Map())`
    // is `[]`, and reading it as arguments would erase every call's input.
    const audit = new Map<string, unknown>();
    for (const hook of [
      ({ args }: { args: Record<string, unknown> }) => audit.set('last', args),
      () => [1, 2].push(3),
      () => 'resolved-42',
      () => new (class Ledger {})(),
    ]) {
      const result = await executeToolMethod(
        method(),
        {
          toolName: 'record_journal',
          rawArgs: { id: 'untouched' },
          context: { source: 'agent' },
        },
        { hooks: { beforeToolCall: hook } },
      );
      expect(result).toEqual({ ok: true, data: { seen: 'untouched' } });
    }
  });

  test('the hook runs once per call, even when the call goes on to throw', async () => {
    // A hook that expands a reference is a lookup with side effects. Running it
    // a second time on the failure path would be a duplicate effect per failed
    // call, and no existing test counted invocations.
    let runs = 0;
    const result = await executeToolMethod(
      method({
        handler: () => {
          throw new Error('boom');
        },
      }),
      { toolName: 'record_journal', rawArgs: { id: 'x' }, context: { source: 'agent' } },
      {
        hooks: {
          beforeToolCall: () => {
            runs += 1;
          },
        },
      },
    );
    expect(result.ok).toBe(false);
    expect(runs).toBe(1);
  });

  test('an extension cannot overwrite the call id the transport supplied', async () => {
    const extension: ToolArgumentExtension = {
      schema: z.object({ tenant: z.string() }),
      resolve: () => ({ toolCallId: 'forged' }),
    };
    let seen: unknown;
    await executeToolMethod(
      method(),
      {
        toolName: 'record_journal',
        rawArgs: { id: 'x', tenant: 'acme' },
        context: { source: 'agent', toolCallId: 'call-real' },
      },
      {
        hooks: {
          afterToolCall: ({ context }) => {
            seen = context.toolCallId;
          },
        },
        coerceJson: true,
        extension,
      },
    );
    expect(seen).toBe('call-real');
  });

  test('a replacement recorded on an already-failed path is not reported as what ran', async () => {
    const extension: ToolArgumentExtension = {
      schema: z.object({ tenant: z.string() }),
      resolve: ({ tenant }) => ({ tenantId: tenant }),
    };
    let observed: AfterToolCallOptions | undefined;
    await executeToolMethod(
      method(),
      {
        toolName: 'record_journal',
        rawArgs: // The extension refuses (tenant is not a string), so the call never runs.
          { id: 'x', tenant: 7 },
        context: { source: 'agent' },
      },
      {
        hooks: {
          beforeToolCall: ({ args }) => ({ ...args, id: 'rewritten' }),
          afterToolCall: (options) => {
            observed = options;
          },
        },
        coerceJson: true,
        extension,
      },
    );
    expect(observed?.result.ok).toBe(false);
    expect(observed?.effectiveArgs).toBeUndefined();
  });

  test('the audit record keeps what the caller sent and names the replacement apart', async () => {
    let observed: AfterToolCallOptions | undefined;
    await executeToolMethod(
      method(),
      {
        toolName: 'record_journal',
        rawArgs: { id: '@previous' },
        context: { source: 'agent' },
      },
      {
        hooks: {
          beforeToolCall: ({ args }) => ({ ...args, id: 'resolved-42' }),
          afterToolCall: (options) => {
            observed = options;
          },
        },
      },
    );
    expect(observed?.args).toEqual({ id: '@previous' });
    expect(observed?.effectiveArgs).toEqual({ id: 'resolved-42' });
  });

  test('an untouched call reports no effectiveArgs at all', async () => {
    let observed: AfterToolCallOptions | undefined;
    await executeToolMethod(
      method(),
      { toolName: 'record_journal', rawArgs: { id: 'plain' }, context: { source: 'agent' } },
      {
        hooks: {
          afterToolCall: (options) => {
            observed = options;
          },
        },
      },
    );
    expect(observed?.effectiveArgs).toBeUndefined();
  });

  /*
   * The hook is handed the RAW arguments, which still carry the extension's own keys; the
   * arguments the schemas see have had them removed. A hook that takes what it was given,
   * changes one field and returns it would put the extension keys back — and they belong to
   * neither schema, so a strict input schema would refuse every rewritten call.
   */
  test('extension keys do not ride back in on the returned record', async () => {
    const extension: ToolArgumentExtension = {
      schema: z.object({ tenant: z.string() }),
      resolve: ({ tenant }) => ({ tenantId: tenant }),
    };
    const result = await executeToolMethod(
      method({ inputSchema: z.strictObject({ id: z.string() }) }),
      {
        toolName: 'record_journal',
        rawArgs: { id: '@previous', tenant: 'acme' },
        context: { source: 'agent' },
      },
      {
        hooks: { beforeToolCall: ({ args }) => ({ ...args, id: 'resolved-42' }) },
        coerceJson: true,
        extension,
      },
    );
    expect(result).toEqual({ ok: true, data: { seen: 'resolved-42' } });
  });

  test('a refusal from the hook still refuses, and the arguments are not consulted', async () => {
    const result = await executeToolMethod(
      method(),
      { toolName: 'record_journal', rawArgs: { id: 'x' }, context: { source: 'agent' } },
      {
        hooks: {
          beforeToolCall: () => {
            throw new Error('denied');
          },
        },
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INTERNAL_SERVER_ERROR');
  });
});
