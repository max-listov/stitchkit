/*
 * A call in flight can say something.
 *
 * A tool that takes ten minutes told a text host nothing: the call was made,
 * and the next thing the host saw was the answer — or a timeout, after which
 * the model called again. The protocol has the channel for exactly this: the
 * host sends a `progressToken` in the request's `_meta`, the server relates
 * `notifications/progress` to that request. The framework read neither, so a
 * long wait was indistinguishable from a hang, including to the model deciding
 * whether to retry.
 *
 * Reporting stays the handler's decision. Progress is only meaningful where an
 * operation has observable stages, and guessing them for a consumer would be
 * inventing a second transport beside the one that exists.
 */
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineContract, type RuntimeContext } from '../src/entrypoints/contract';
import { createImplement } from '../src/server/implement';
import { mountAgent } from '../src/tools/agent';
import { createMcpHandler } from '../src/tools/mcp/handler';
import { createMcpProgressReporter } from '../src/tools/mcp/progress';

const MODERN = '2026-07-28';

type Report = (context: RuntimeContext) => Promise<unknown>;

function handlerFor(report: Report) {
  const contract = defineContract(
    { prefix: 'jobs' },
    {
      render: {
        method: 'POST',
        path: '/',
        desc: 'Render something slow',
        expose: ['MCP'],
        input: z.object({ id: z.string() }),
        output: z.object({ done: z.boolean() }),
      },
    },
  );
  const service = createImplement<RuntimeContext>()(contract, {
    render: async (context) => {
      await report(context);
      return { done: true };
    },
  });
  return createMcpHandler({
    serverInfo: { name: 'progress-test', version: '1' },
    auth: () => ({}),
    services: [service],
  });
}

function call(meta: Record<string, unknown> = {}): Request {
  return new Request('http://localhost/mcp', {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-method': 'tools/call',
      'mcp-name': 'render_job',
      'mcp-protocol-version': MODERN,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'render_job',
        arguments: { id: 'a' },
        _meta: {
          'io.modelcontextprotocol/protocolVersion': MODERN,
          'io.modelcontextprotocol/clientInfo': { name: 'progress-test', version: '1' },
          'io.modelcontextprotocol/clientCapabilities': {},
          ...meta,
        },
      },
    }),
  });
}

/** Every `notifications/progress` the host would receive, in order. */
function progressFrames(body: string): Array<Record<string, unknown>> {
  const frames: Array<Record<string, unknown>> = [];
  for (const line of body.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const parsed: unknown = JSON.parse(line.slice('data: '.length));
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'method' in parsed &&
      parsed.method === 'notifications/progress'
    ) {
      frames.push((parsed as unknown as { params: Record<string, unknown> }).params);
    }
  }
  return frames;
}

describe('a tool reports progress to the host that asked for it', () => {
  test('an update reaches the host on the token it sent', async () => {
    const handler = handlerFor(
      (context) =>
        context.reportProgress?.({ message: 'rendering', progress: 3, total: 10 }) ??
        Promise.resolve(),
    );
    const body = await (await handler.fetch(call({ progressToken: 'tok-1' }))).text();
    expect(progressFrames(body)).toEqual([
      { progressToken: 'tok-1', progress: 3, total: 10, message: 'rendering' },
    ]);
  });

  test('a numeric token is carried as a number, not stringified', async () => {
    const handler = handlerFor(
      (context) => context.reportProgress?.({ message: 'x' }) ?? Promise.resolve(),
    );
    const body = await (await handler.fetch(call({ progressToken: 42 }))).text();
    expect(progressFrames(body)[0]?.progressToken).toBe(42);
  });

  test('an update with no number carries the ordinal, and no invented scale', async () => {
    // The protocol requires `progress`. A handler naming a stage usually has no
    // scale to name it on, and the ordinal of the update is a fact; a percentage
    // would be a claim nobody measured. `total` stays absent so the host renders
    // a counter rather than a bar.
    const handler = handlerFor(async (context) => {
      await context.reportProgress?.({ message: 'queued' });
      await context.reportProgress?.({ message: 'running' });
    });
    const body = await (await handler.fetch(call({ progressToken: 'tok' }))).text();
    expect(progressFrames(body)).toEqual([
      { progressToken: 'tok', progress: 1, message: 'queued' },
      { progressToken: 'tok', progress: 2, message: 'running' },
    ]);
  });

  test('the declared token is visible on the call context', async () => {
    let seen: unknown;
    const handler = handlerFor(async (context) => {
      seen = context.mcp?.progressToken;
    });
    await handler.fetch(call({ progressToken: 'tok-7' }));
    expect(seen).toBe('tok-7');
  });

  test('a host that asked for nothing gets exactly what it got before', async () => {
    const handler = handlerFor(
      (context) => context.reportProgress?.({ message: 'rendering' }) ?? Promise.resolve(),
    );
    const response = await handler.fetch(call());
    // Not merely "no progress frames": the response is still plain JSON. A
    // stream would be a behaviour change for every host on the old path.
    expect(response.headers.get('content-type')).toBe('application/json');
    const body: unknown = JSON.parse(await response.text());
    expect(
      (body as { result: { structuredContent: unknown } }).result.structuredContent,
    ).toEqual({ done: true });
  });

  test('reporting without a token is a no-op, not a failure', async () => {
    let threw: unknown;
    const handler = handlerFor(async (context) => {
      try {
        await context.reportProgress?.({ message: 'x', progress: 1 });
      } catch (error) {
        threw = error;
      }
    });
    const body: unknown = JSON.parse(await (await handler.fetch(call())).text());
    expect(threw).toBeUndefined();
    expect(
      (body as { result: { structuredContent: unknown } }).result.structuredContent,
    ).toEqual({ done: true });
  });

  test('`reportProgress` is present even when no host is listening', async () => {
    // So a handler calls it unconditionally instead of branching on transport.
    let present: boolean | undefined;
    const handler = handlerFor(async (context) => {
      present = typeof context.reportProgress === 'function';
    });
    await handler.fetch(call());
    expect(present).toBe(true);
  });

  test('the framework sends nothing on its own', async () => {
    const handler = handlerFor(async () => undefined);
    const body = await (await handler.fetch(call({ progressToken: 'tok' }))).text();
    // Progress is meaningful only where an operation has observable stages.
    // Manufacturing one per call would be the framework inventing a second
    // transport beside the one the protocol already gives the handler.
    expect(progressFrames(body)).toEqual([]);
  });
});

/*
 * The guarantee the handler path cannot reach: a transport that refuses the
 * notification. Through a real server it never refuses, so a mutation removing
 * the swallow stayed green — the reporter is exercised directly here instead,
 * because "a message about work must not kill the work" is the whole reason the
 * swallow is there.
 */
describe('a refused notification cannot fail the call', () => {
  /** The shape the reporter reads — a request that declared a token. */
  function contextWith(notify: () => Promise<void>) {
    return { mcpReq: { _meta: { progressToken: 'tok' }, notify } } as unknown as Parameters<
      typeof createMcpProgressReporter
    >[0];
  }

  test('a rejecting transport is swallowed', async () => {
    const report = createMcpProgressReporter(
      contextWith(() => Promise.reject(new Error('stream closed'))),
    );
    expect(await report({ message: 'x' })).toBeUndefined();
  });

  test('a synchronously throwing transport is swallowed too', async () => {
    const report = createMcpProgressReporter(
      contextWith(() => {
        throw new Error('no transport');
      }),
    );
    expect(await report({ message: 'x' })).toBeUndefined();
  });

  test('a refused update still counts, so the ordinal keeps advancing', async () => {
    // Otherwise a host that missed one frame would see the next one repeat a
    // number it already had, which reads as "no movement" rather than "one lost".
    const sent: Array<Record<string, unknown>> = [];
    let first = true;
    const report = createMcpProgressReporter(
      contextWith(async (...args: unknown[]) => {
        if (first) {
          first = false;
          throw new Error('dropped');
        }
        sent.push((args[0] as unknown as { params: Record<string, unknown> }).params);
      }),
    );
    await report({ message: 'one' });
    await report({ message: 'two' });
    expect(sent).toEqual([{ progressToken: 'tok', progress: 2, message: 'two' }]);
  });
});

/*
 * Present wherever a tool runs, so a handler never asks which transport it is on.
 *
 * The guide said "always present" while only the MCP path wrote it, which made
 * the sentence false on three transports out of four and the recommended call a
 * TypeError. The no-op now comes from the shared runner, and these hold the
 * sentence to the code.
 */
describe('every tool call carries a reporter, listening or not', () => {
  const service = {
    name: 'jobs',
    prefix: 'jobs',
    scope: 'public',
    methods: {
      render: {
        method: 'POST' as const,
        path: '/',
        serviceName: 'jobs',
        key: 'render',
        desc: 'Render',
        inputSchema: z.object({ id: z.string() }),
        outputSchema: z.object({ done: z.boolean(), reported: z.boolean() }),
        handler: async (context: { reportProgress?: (u: unknown) => Promise<void> }) => {
          const present = typeof context.reportProgress === 'function';
          // Called unconditionally, which is the whole claim: a handler that has
          // to ask whether anyone is listening is a handler that branches on
          // transport.
          await context.reportProgress?.({ message: 'working' });
          return { done: true, reported: present };
        },
      },
    },
  };

  test('an agent-mounted tool has one, and calling it is a no-op rather than a crash', async () => {
    const tools = mountAgent(service as never);
    const execute = tools.render_job?.execute;
    if (!execute) throw new Error('expected a mounted tool');
    const result = await execute(
      { id: 'a' },
      { toolCallId: 'c', messages: [], context: undefined },
    );
    expect(result).toEqual({ done: true, reported: true });
  });
});
