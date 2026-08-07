/**
 * A tool call runs in its own request context.
 *
 * `executeToolMethod` opened no scope, so every call in a request wrote into one
 * `AsyncLocalStorage` store. The AI SDK runs a step's calls with `Promise.all`,
 * so `beforeHandle(A)` stamped its entity and `beforeHandle(B)` overwrote it —
 * and call A's audit row named call B's entity. Found in production, on rows
 * that looked perfectly ordinary. → ADR 0045.
 *
 * Every case here drives the **real** executor through a real mount. The defect
 * survived from the first commit because every existing tool-audit test calls
 * `afterToolCall` directly, so nothing ever exercised the ALS interaction.
 */
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineContract } from '../src/contract';
import {
  createAuditHook,
  getRequestContext,
  type RequestEvent,
  runWithRequestContext,
  setRequestDimensions,
  setRequestError,
  setRequestUser,
  wrapInRequestContext,
} from '../src/observability';
import { childSpan } from '../src/observability/trace';
import { implement } from '../src/server';
import type { ToolLifecycle } from '../src/tools';
import { mountAgent } from '../src/tools/agent';

const contract = defineContract(
  { prefix: 'widgets' },
  {
    touch: {
      method: 'POST',
      path: '/touch',
      desc: 'Touch a widget',
      input: z.object({ id: z.string() }),
      output: z.object({ ok: z.boolean() }),
      expose: ['AGENT'],
      toolName: 'widget_touch',
    },
  },
);

const service = implement(contract, {
  touch: async () => {
    // Yield, so two concurrent calls genuinely interleave.
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { ok: true };
  },
});

/** Mount the tool with an audit sink and whatever lifecycle a case needs. */
function mount(lifecycle?: ToolLifecycle) {
  const events: RequestEvent[] = [];
  const audit = createAuditHook({ write: (e) => void events.push(e) });
  const tools = mountAgent(service, { hooks: audit.toolCall, lifecycle });
  const execute = tools.widget_touch?.execute;
  if (!execute) throw new Error('test setup: no widget_touch tool');
  const call = (id: string) =>
    execute({ id }, { toolCallId: id, messages: [], context: undefined });
  return { events, audit, call };
}

/** Drive calls inside one HTTP request, and settle the detached audit writes. */
async function inRequest(
  audit: ReturnType<typeof createAuditHook>,
  body: () => Promise<void>,
) {
  const handler = audit.http(async () => {
    await body();
    return new Response('ok');
  });
  await wrapInRequestContext(handler)(
    new Request('http://localhost/mcp', { method: 'POST' }),
    undefined,
  );
  await Bun.sleep(40);
}

const toolRows = (events: RequestEvent[]) => events.filter((e) => e.toolName !== undefined);
const httpRow = (events: RequestEvent[]) => events.find((e) => e.toolName === undefined);
/** The row for the call that was given this id. */
const rowFor = (events: RequestEvent[], id: string) =>
  toolRows(events).find((e) => JSON.stringify(e.payload).includes(`"${id}"`));

describe('concurrent calls do not write into each other', () => {
  test('each row carries the entity its own call stamped', async () => {
    const { events, audit, call } = mount({
      beforeHandle: (ctx) => {
        setRequestDimensions({ entityId: String((ctx.input as { id: string }).id) });
      },
    });

    await inRequest(audit, async () => {
      await Promise.all([call('A'), call('B')]);
    });

    // The reported defect: both rows used to say `B`.
    expect(rowFor(events, 'A')?.dimensions).toEqual({ entityId: 'A' });
    expect(rowFor(events, 'B')?.dimensions).toEqual({ entityId: 'B' });
  });

  test('the fork spans the whole call, so a beforeToolCall write reaches its own row', async () => {
    // Placement matters and is easy to get wrong: `afterToolCall` — where the
    // audit row is built — must be inside the same fork as the hooks that wrote.
    const events: RequestEvent[] = [];
    const audit = createAuditHook({ write: (e) => void events.push(e) });
    const tools = mountAgent(service, {
      hooks: {
        beforeToolCall: ({ args }) => {
          setRequestDimensions({ stampedEarly: String((args as { id: string }).id) });
        },
        afterToolCall: audit.toolCall.afterToolCall,
      },
    });
    const execute = tools.widget_touch?.execute;
    if (!execute) throw new Error('test setup: no tool');

    await inRequest(audit, async () => {
      await Promise.all([
        execute({ id: 'A' }, { toolCallId: 'A', messages: [], context: undefined }),
        execute({ id: 'B' }, { toolCallId: 'B', messages: [], context: undefined }),
      ]);
    });

    expect(rowFor(events, 'A')?.dimensions).toEqual({ stampedEarly: 'A' });
    expect(rowFor(events, 'B')?.dimensions).toEqual({ stampedEarly: 'B' });
  });
});

describe('correlation survives the fork', () => {
  test('a tool row shares the traceId of the request and is a child of its span', async () => {
    // The consuming project stitches request → loop → tool by exactly this, and
    // said plainly that losing it would be worse than the bug being fixed.
    const { events, audit, call } = mount();

    await inRequest(audit, async () => {
      await Promise.all([call('A'), call('B')]);
    });

    const http = httpRow(events);
    expect(http).toBeDefined();
    for (const row of toolRows(events)) {
      expect(row.traceId).toBe(http?.traceId ?? '');
      expect(row.parentSpanId).toBe(http?.spanId);
      expect(row.spanId).not.toBe(http?.spanId);
    }
  });

  test('a call that records nothing still inherits what the request knew', async () => {
    const { events, audit, call } = mount();

    await inRequest(audit, async () => {
      setRequestUser('u-1');
      setRequestDimensions({ tenant: 'acme' });
      await call('A');
    });

    // A fork must not blank the identity the request already established.
    expect(rowFor(events, 'A')?.dimensions).toEqual({ tenant: 'acme' });
  });

  test('the forked context describes the call, not the enclosing route', async () => {
    let seen: ReturnType<typeof getRequestContext>;
    const { audit, call } = mount({
      beforeHandle: () => {
        seen = getRequestContext();
      },
    });

    await inRequest(audit, async () => {
      await call('A');
    });

    // The request says `http` / `/mcp`; that is true of the request and
    // misleading about the call.
    expect(seen?.source).toBe('agent');
    expect(seen?.path).toBe('/agent/widget_touch');
    expect(seen?.serviceName).toBe('widgets');
    expect(seen?.action).toBe('touch');
  });
});

describe('what the fork deliberately stops doing', () => {
  test('a tool write no longer reaches the enclosing request row', async () => {
    // Pinned on purpose: without this a later "helpful" change restores the
    // leak and nothing complains. The value is not lost — it is on the tool row,
    // joinable by the shared traceId (asserted above).
    const { events, audit, call } = mount({
      beforeHandle: (ctx) => {
        setRequestDimensions({ entityId: String((ctx.input as { id: string }).id) });
      },
    });

    await inRequest(audit, async () => {
      await call('A');
    });

    expect(httpRow(events)?.dimensions).toBeUndefined();
  });

  test('sequential calls stop accumulating each other dimensions', async () => {
    // The old store merged, so the second row carried the first call's keys too.
    // "Unchanged for sequential calls" was never true; this is the honest
    // criterion — a call produces the row it would produce alone.
    const { events, audit, call } = mount({
      beforeHandle: (ctx) => {
        const id = String((ctx.input as { id: string }).id);
        setRequestDimensions({ [`key_${id}`]: id });
      },
    });

    await inRequest(audit, async () => {
      await call('A');
      await call('B');
    });

    expect(rowFor(events, 'A')?.dimensions).toEqual({ key_A: 'A' });
    expect(rowFor(events, 'B')?.dimensions).toEqual({ key_B: 'B' });
  });
});

describe('no ambient context — nothing is invented', () => {
  test('a call outside a request forks nothing and gains no phantom parent', async () => {
    // stdio MCP and `createCli` run with no store at all. There is no shared
    // state to corrupt there, and minting a root would stamp every row with a
    // `parentSpanId` pointing at a span no row ever carries.
    const { events, call } = mount({
      beforeHandle: () => {
        setRequestDimensions({ entityId: 'ignored' });
      },
    });

    await call('A');
    await Bun.sleep(40);

    const row = rowFor(events, 'A');
    expect(row).toBeDefined();
    expect(row?.parentSpanId).toBeUndefined();
    // `setRequestDimensions` stays the no-op it has always been here.
    expect(row?.dimensions).toBeUndefined();
  });
});

describe('the shape the incident actually had', () => {
  test('request → agent loop → concurrent tools: each row keeps its own entity', async () => {
    // The reporter's production topology: an MCP request, an agent loop that
    // opens its OWN context, and tool calls inside it. Two candidate parents,
    // which is the case a flat probe cannot produce.
    const { events, audit, call } = mount({
      beforeHandle: (ctx) => {
        setRequestDimensions({ entityId: String((ctx.input as { id: string }).id) });
      },
    });

    await inRequest(audit, async () => {
      const loop = getRequestContext();
      if (!loop) throw new Error('test setup: no request context');
      // The loop's own scope, nested inside the request's.
      await runWithRequestContext({ ...loop, trace: childSpan(loop.trace) }, async () => {
        await Promise.all([call('A'), call('B')]);
      });
    });

    expect(rowFor(events, 'A')?.dimensions).toEqual({ entityId: 'A' });
    expect(rowFor(events, 'B')?.dimensions).toEqual({ entityId: 'B' });
    // The tools hang off the loop's span, not the request's — the hierarchy the
    // reporter reads their traces by.
    const loopSpan = rowFor(events, 'A')?.parentSpanId;
    expect(loopSpan).toBeDefined();
    expect(rowFor(events, 'B')?.parentSpanId).toBe(loopSpan);
    expect(loopSpan).not.toBe(httpRow(events)?.spanId);
    // …and everything still shares one traceId.
    expect(rowFor(events, 'A')?.traceId).toBe(httpRow(events)?.traceId ?? '');
  });
});

describe('a failure stays inside the call that failed', () => {
  test('an error recorded before the call is not visible inside the call', async () => {
    // Read the context, not the emitted row: `createAuditHook` derives a tool
    // row's error fields from the `ToolResult` and never from `ctx.error`, so a
    // row assertion here would pass with the reset deleted — and did.
    let seenInHandler: unknown;
    let seenInHook: unknown;
    const events: RequestEvent[] = [];
    const audit = createAuditHook({ write: (e) => void events.push(e) });
    const tools = mountAgent(service, {
      hooks: {
        afterToolCall: (options) => {
          seenInHook = getRequestContext()?.error;
          return audit.toolCall.afterToolCall?.(options);
        },
      },
      lifecycle: {
        beforeHandle: () => {
          seenInHandler = getRequestContext()?.error;
        },
      },
    });
    const execute = tools.widget_touch?.execute;
    if (!execute) throw new Error('test setup: no tool');

    await inRequest(audit, async () => {
      // The request already failed at something; a successful call must not
      // inherit it, or a consumer's own row marks the call failed.
      setRequestError({ code: 'EARLIER_FAILURE', message: 'not the call' });
      await execute({ id: 'A' }, { toolCallId: 'A', messages: [], context: undefined });
    });

    expect(seenInHandler).toBeUndefined();
    expect(seenInHook).toBeUndefined();
    expect(rowFor(events, 'A')?.ok).toBe(true);
  });

  test('a throwing tool records its own failure and leaves the request row alone', async () => {
    const events: RequestEvent[] = [];
    const audit = createAuditHook({ write: (e) => void events.push(e) });
    const boom = implement(contract, {
      touch: () => {
        throw new Error('handler exploded');
      },
    });
    // The hook that makes this bite: without it nothing writes `ctx.error`, and
    // the assertion below would hold even on the un-forked executor.
    const tools = mountAgent(boom, {
      hooks: {
        ...audit.toolCall,
        onToolError: () => setRequestError({ code: 'TOOL_BLEW_UP' }),
      },
    });
    const execute = tools.widget_touch?.execute;
    if (!execute) throw new Error('test setup: no tool');

    const original = console.error;
    console.error = () => undefined;
    try {
      await inRequest(audit, async () => {
        setRequestError({ code: 'PARENT_ERR' });
        await execute({ id: 'A' }, { toolCallId: 'A', messages: [], context: undefined });
      });
    } finally {
      console.error = original;
    }

    expect(rowFor(events, 'A')?.ok).toBe(false);
    // The request kept its own error; the tool's did not overwrite it.
    expect(httpRow(events)?.errorCode).toBe('PARENT_ERR');
  });
});

describe('the fork starts before the call does', () => {
  test('a ToolExtend.resolve write belongs to its own call', async () => {
    // `resolve` is where a project resolves the tenant for THIS call, and it
    // runs before the executor. Left outside the fork it wrote into the shared
    // store and reproduced the original defect at one remove.
    const events: RequestEvent[] = [];
    const audit = createAuditHook({ write: (e) => void events.push(e) });
    const tools = mountAgent(service, {
      hooks: audit.toolCall,
      extend: {
        schema: { tenantId: z.string() },
        resolve: async (args) => {
          const tenantId = String((args as { tenantId: string }).tenantId);
          await new Promise((resolve) => setTimeout(resolve, 5));
          setRequestDimensions({ tenant: tenantId });
          return { tenantId };
        },
      },
    });
    const execute = tools.widget_touch?.execute;
    if (!execute) throw new Error('test setup: no tool');

    await inRequest(audit, async () => {
      await Promise.all([
        execute(
          { id: 'A', tenantId: 'T-A' },
          { toolCallId: 'A', messages: [], context: undefined },
        ),
        execute(
          { id: 'B', tenantId: 'T-B' },
          { toolCallId: 'B', messages: [], context: undefined },
        ),
      ]);
    });

    expect(rowFor(events, 'A')?.dimensions).toEqual({ tenant: 'T-A' });
    expect(rowFor(events, 'B')?.dimensions).toEqual({ tenant: 'T-B' });
    expect(httpRow(events)?.dimensions).toBeUndefined();
  });
});
