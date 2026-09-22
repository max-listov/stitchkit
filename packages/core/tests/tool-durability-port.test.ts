import { describe, expect, test } from 'bun:test';
import type { ToolSet } from 'ai';
import { z } from 'zod';
import type { MethodDef } from '../src/server/types';
import {
  type AgentStoreEventEnvelope,
  createLocalStepDurability,
  type StepDurabilityLedger,
  type ToolDurability,
} from '../src/tools';
import { mountAgent } from '../src/tools/agent';
import { createToolDurabilityContext } from '../src/tools/durability-context';

/*
 * `mountAgent` could already put `step` / `sleep` / `waitFor` into a tool body — but only
 * `agent-runtime` could supply them, because the only implementation is built over the agent
 * store. So a capability designed for mounted tools was reachable only by adopting a different
 * product whole, and an application running its own loop wrote the same durable bookkeeping
 * beside its tools instead of inside them.
 *
 * Publishing the factory agent-runtime uses would not have fixed that: its parameter is a type
 * only the store constructs, so the export would be public and unusable — the shape ADR 0142
 * refuses by name. The port goes the other way: the tools layer states what it needs, and
 * whoever already has a ledger satisfies it.
 */

/** The mounted tool's executor, narrowed once — the shape every agent test uses. */
function executable(tools: ToolSet, name: string) {
  const execute = tools[name]?.execute;
  if (!execute) throw new Error(`expected executable tool ${name}`);
  return execute;
}

const method: MethodDef<unknown, unknown, unknown> = {
  method: 'POST',
  path: '/',
  serviceName: 'media',
  key: 'render',
  desc: 'Render one asset',
  inputSchema: z.object({ prompt: z.string() }),
  outputSchema: z.object({ asset: z.string() }),
  handler: async (ctx) => {
    const durability = ctx.step as ToolDurability['step'] | undefined;
    if (!durability) return { asset: 'no-durability' };
    const asset = await durability('render', () => `asset-for-${String(ctx.input)}`);
    return { asset };
  },
};

const service = {
  name: 'media',
  prefix: 'media',
  scope: 'public',
  methods: { render: method },
};

function ledger(): { durability: ToolDurability; ran: string[] } {
  const recorded = new Map<string, unknown>();
  const ran: string[] = [];
  return {
    ran,
    durability: {
      step: async (name, body) => {
        if (recorded.has(name)) return recorded.get(name) as never;
        ran.push(name);
        const value = await body();
        recorded.set(name, value);
        return value;
      },
      sleep: async () => undefined,
      waitFor: async () => undefined as never,
    },
  };
}

describe('a mounted tool body can be made restartable without agent-runtime', () => {
  test('a declared factory puts step into the handler context', async () => {
    const { durability, ran } = ledger();
    const tools = mountAgent(service, { durability: () => durability });
    const execute = executable(tools, 'render_media');

    const result = await execute(
      { prompt: 'forest' },
      { toolCallId: 'call-1', messages: [], context: undefined },
    );
    expect(result).toEqual({ asset: 'asset-for-[object Object]' });
    expect(ran).toEqual(['render']);
  });

  test('a replay returns the record instead of running the body again', async () => {
    const { durability, ran } = ledger();
    const tools = mountAgent(service, { durability: () => durability });
    const execute = executable(tools, 'render_media');

    await execute(
      { prompt: 'forest' },
      { toolCallId: 'call-1', messages: [], context: undefined },
    );
    await execute(
      { prompt: 'forest' },
      { toolCallId: 'call-1', messages: [], context: undefined },
    );
    // The whole point: the second call did not re-run the effectful body.
    expect(ran).toEqual(['render']);
  });

  test('the factory is given the provider call id, so a ledger can key by it', async () => {
    const seen: string[] = [];
    const { durability } = ledger();
    const tools = mountAgent(service, {
      durability: (toolCallId) => {
        seen.push(toolCallId);
        return durability;
      },
    });
    const execute = executable(tools, 'render_media');
    await execute({ prompt: 'a' }, { toolCallId: 'call-7', messages: [], context: undefined });
    expect(seen).toEqual(['call-7']);
  });

  test('the call signal reaches the factory, so a park can end when the call does', async () => {
    let seen: AbortSignal | undefined;
    const { durability } = ledger();
    const tools = mountAgent(service, {
      durability: (_toolCallId, signal) => {
        seen = signal;
        return durability;
      },
    });
    const execute = executable(tools, 'render_media');
    const controller = new AbortController();
    await execute(
      { prompt: 'a' },
      {
        toolCallId: 'call-8',
        messages: [],
        context: undefined,
        abortSignal: controller.signal,
      },
    );
    expect(seen).toBe(controller.signal);
  });

  test("the runtime's own durability wins over a declared factory", async () => {
    // When `agent-runtime` drives the call it puts its durability into the SDK
    // context. That one is the run's ledger, and the run is recorded there — a
    // declared factory must not silently redirect its steps elsewhere.
    const fromRuntime = ledger();
    const fromFactory = ledger();
    const tools = mountAgent(service, { durability: () => fromFactory.durability });
    const execute = executable(tools, 'render_media');
    await execute(
      { prompt: 'a' },
      {
        toolCallId: 'call-10',
        messages: [],
        context: createToolDurabilityContext(() => fromRuntime.durability as never),
      },
    );
    expect(fromRuntime.ran).toEqual(['render']);
    expect(fromFactory.ran).toEqual([]);
  });

  test('without the option the tool body sees no durability at all', async () => {
    const tools = mountAgent(service);
    const execute = executable(tools, 'render_media');
    expect(
      await execute(
        { prompt: 'a' },
        { toolCallId: 'call-9', messages: [], context: undefined },
      ),
    ).toEqual({
      asset: 'no-durability',
    });
  });
});

/*
 * The engine, not only the port.
 *
 * A port alone would have handed the consumer a seam and left them to write replay,
 * absolute deadlines and park/deliver themselves — more code than the sixty lines they
 * already had beside their tools. The engine is self-contained (its runtime closure is
 * itself and zod; the ledger it needs is two methods), so it ships from `stitchkit/tools`
 * and the consumer supplies the two methods over the database they already have.
 */
describe('the durability engine runs over a two-method ledger the application owns', () => {
  /** A ledger written from scratch — the shape a consumer would put over their own table. */
  function twoMethodLedger(): StepDurabilityLedger & { rows: AgentStoreEventEnvelope[] } {
    const rows: AgentStoreEventEnvelope[] = [];
    return {
      rows,
      appendEvent: async (input) => {
        const row: AgentStoreEventEnvelope = {
          schemaVersion: 1,
          eventId: `e${rows.length + 1}`,
          conversationId: input.conversationId,
          seq: rows.length + 1,
          kind: input.kind,
          occurredAt: new Date().toISOString(),
          payload: input.payload,
          ...(input.ignorable && { ignorable: true }),
        };
        rows.push(row);
        return row;
      },
      readEvents: async (input) => {
        const from = input.fromSeq ?? 1;
        const items = rows.filter(
          (row) =>
            row.conversationId === input.conversationId &&
            row.seq >= from &&
            (input.toSeq === undefined || row.seq <= input.toSeq),
        );
        return { items };
      },
    };
  }

  test('a replay in a fresh engine over the same ledger skips the body', async () => {
    const ledger = twoMethodLedger();
    let bodies = 0;
    const method: MethodDef<unknown, unknown, unknown> = {
      method: 'POST',
      path: '/',
      serviceName: 'media',
      key: 'render',
      desc: 'Render one asset',
      inputSchema: z.object({ prompt: z.string() }),
      outputSchema: z.object({ asset: z.string() }),
      handler: async (ctx) => {
        const step = ctx.step as ToolDurability['step'];
        const asset = await step('render', () => {
          bodies += 1;
          return 'asset-1';
        });
        return { asset };
      },
    };
    const tools = mountAgent(
      { name: 'media', prefix: 'media', scope: 'public', methods: { render: method } },
      {
        // A fresh engine per call, as a restarted host would build one — the
        // ledger is the only thing that survives, and it is what makes replay work.
        durability: (toolCallId) =>
          createLocalStepDurability({
            store: ledger,
            conversationId: 'conversation-1',
            runId: toolCallId,
          }),
      },
    );
    const execute = executable(tools, 'render_media');
    const call = { toolCallId: 'call-1', messages: [], context: undefined };

    expect(await execute({ prompt: 'forest' }, call)).toEqual({ asset: 'asset-1' });
    expect(await execute({ prompt: 'forest' }, call)).toEqual({ asset: 'asset-1' });

    expect(bodies).toBe(1);
    // The proof is in the ledger the application owns: one recorded step.
    expect(ledger.rows.map((row) => row.kind)).toEqual(['durability/step']);
  });
});
