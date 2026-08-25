import { describe, expect, test } from 'bun:test';
import { simulateReadableStream, tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import {
  type AgentRunEvent,
  type AgentRuntimeEvent,
  type AgentUsage,
  createAgentObservability,
  createAgentRuntime,
  createMemoryAgentRuntimeStore,
  defineAgentProtocol,
} from '../src/agent-runtime';
import { addUsage, unknownUsage } from '../src/agent-runtime/runtime-internals';

const sdkUsage = (input: number, output: number) => ({
  inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: output, text: output, reasoning: undefined },
});

const reported = (value: number) => ({ value, provenance: 'provider-reported' as const });

/** Mirrors the shipped OpenRouter adapter: per-step cost out of provider metadata. */
const normalizeUsage = ({
  usage,
  providerMetadata,
}: {
  usage: { inputTokens?: number; outputTokens?: number };
  providerMetadata?: unknown;
}): AgentUsage => {
  const meta = providerMetadata as { openrouter?: { usage?: { cost?: number } } } | undefined;
  const cost = meta?.openrouter?.usage?.cost;
  return {
    inputTokens: reported(usage.inputTokens ?? 0),
    outputTokens: reported(usage.outputTokens ?? 0),
    ...(cost !== undefined && {
      cost: { value: cost, currency: 'USD', provenance: 'provider-reported' as const },
    }),
  };
};

function runtimeWith(input: {
  model: MockLanguageModelV4;
  inputPolicy: 'queue' | 'supersede';
  observed: AgentRunEvent[];
  delivered?: AgentRuntimeEvent[];
}) {
  return createAgentRuntime({
    protocol: defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}) }),
    store: createMemoryAgentRuntimeStore(),
    models: {
      resolve: () => ({
        descriptor: {
          provider: 'test',
          modelId: 'expensive-model',
          contextWindow: 100_000,
          capabilities: [],
        },
        model: input.model,
        normalizeUsage,
      }),
    },
    prompt: () => ({
      instructions: 'test',
      sections: [],
      instructionTokens: { provenance: 'unavailable' },
      contextDecision: 'unavailable',
    }),
    tools: () => ({
      ping: tool({ description: 'p', inputSchema: z.object({}), execute: async () => 'pong' }),
    }),
    loop: { maxSteps: 10 },
    runs: { inputPolicy: input.inputPolicy },
    observe: createAgentObservability({
      write: (event) => {
        input.observed.push(event);
      },
    }),
    ...(input.delivered && {
      publish: (event: AgentRuntimeEvent) => {
        input.delivered?.push(event);
      },
    }),
  });
}

/** Three steps costing $0.50, $1.00 and $1.50 — three dollars in total. */
function threeStepModel() {
  let call = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      call += 1;
      const last = call === 3;
      const body = last
        ? [
            { type: 'text-start', id: 'text-1' },
            { type: 'text-delta', id: 'text-1', delta: 'done' },
            { type: 'text-end', id: 'text-1' },
          ]
        : [{ type: 'tool-call', toolCallId: `call-${call}`, toolName: 'ping', input: '{}' }];
      return {
        stream: simulateReadableStream({
          chunks: [
            ...body,
            {
              type: 'finish',
              finishReason: { unified: last ? 'stop' : 'tool-calls', raw: undefined },
              usage: sdkUsage(1_000 * call, 100 * call),
              providerMetadata: { openrouter: { usage: { cost: 0.5 * call } } },
            },
          ],
        } as never),
      };
    },
  });
}

const send = (
  runtime: ReturnType<typeof createAgentRuntime>,
  idempotencyKey: string,
  text: string,
) =>
  runtime.submit({
    conversationId: 'conversation-1',
    idempotencyKey,
    context: {},
    parts: [{ type: 'text', text }],
    metadata: {},
  });

describe('a run reports what it spent, and names what it does not know', () => {
  test('a successful multi-step run reports every step of the money', async () => {
    const observed: AgentRunEvent[] = [];
    const runtime = runtimeWith({ model: threeStepModel(), inputPolicy: 'queue', observed });
    await send(runtime, 'input-1', 'go').result;
    await runtime.close();

    const terminal = observed.find((event) => event.type === 'run-terminal');
    // $0.50 + $1.00 + $1.50. This used to be 1.5 — the last step's cost, grafted
    // onto every step's tokens, and labelled as though the provider said it.
    expect(terminal?.usage?.cost?.value).toBe(3);
    expect(terminal?.usage?.cost?.currency).toBe('USD');
    // A sum this code performed is not a figure the provider handed us.
    expect(terminal?.usage?.cost?.provenance).toBe('computed');
    // Tokens too. `totalUsage` is a sum the AI SDK performed over per-step
    // provider figures, not a run total any provider handed over, and which
    // loop did the adding is not a difference a caller filtering for a billable
    // figure cares about. A run total on a terminal event is always `computed`;
    // the provider's own word lives on `step-finished`, per step.
    expect(terminal?.usage?.inputTokens).toEqual({ value: 6_000, provenance: 'computed' });
    expect(terminal?.usage?.outputTokens).toEqual({ value: 600, provenance: 'computed' });
    const steps = observed.filter((event) => event.type === 'step-finished');
    expect(steps).toHaveLength(3);
    expect(steps[0]?.usage?.inputTokens).toEqual(reported(1_000));
  });

  test('a run that ends before any step finishes says it does not know', async () => {
    const observed: AgentRunEvent[] = [];
    const fragment = Promise.withResolvers<void>();
    const model = new MockLanguageModelV4({
      doStream: async ({ abortSignal }) => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'text-start', id: 'text-1' });
            controller.enqueue({ type: 'text-delta', id: 'text-1', delta: 'expensive' });
            fragment.resolve();
            abortSignal?.addEventListener('abort', () => controller.close(), { once: true });
          },
        }),
      }),
    });
    const runtime = runtimeWith({ model, inputPolicy: 'supersede', observed });
    const first = send(runtime, 'input-1', 'Hello');
    await first.accepted;
    await fragment.promise;
    send(runtime, 'input-2', 'Actually…');
    await first.result;
    await runtime.close();

    const terminal = observed.find(
      (event) => event.type === 'run-terminal' && event.terminalReason === 'superseded',
    );
    // Present, not absent. Silence read the same as "this run spent nothing",
    // and those are the two facts that most need telling apart.
    expect(terminal?.usage).toEqual(unknownUsage());
  });
});

describe('a multi-step run that is abandoned reports the steps it finished', () => {
  test('the accumulation, not the last step', async () => {
    const observed: AgentRunEvent[] = [];
    const secondStepDone = Promise.withResolvers<void>();
    let call = 0;
    const model = new MockLanguageModelV4({
      doStream: async ({ abortSignal }) => {
        call += 1;
        if (call <= 2) {
          if (call === 2) queueMicrotask(() => secondStepDone.resolve());
          return {
            stream: simulateReadableStream({
              chunks: [
                {
                  type: 'tool-call',
                  toolCallId: `call-${call}`,
                  toolName: 'ping',
                  input: '{}',
                },
                {
                  type: 'finish',
                  finishReason: { unified: 'tool-calls', raw: undefined },
                  usage: sdkUsage(1_000 * call, 100 * call),
                  providerMetadata: { openrouter: { usage: { cost: 0.5 * call } } },
                },
              ],
            } as never),
          };
        }
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: 'stream-start', warnings: [] });
              controller.enqueue({ type: 'text-start', id: 'text-1' });
              controller.enqueue({ type: 'text-delta', id: 'text-1', delta: 'partial' });
              abortSignal?.addEventListener('abort', () => controller.close(), { once: true });
            },
          }),
        };
      },
    });
    const runtime = runtimeWith({ model, inputPolicy: 'supersede', observed });
    const first = send(runtime, 'input-1', 'go');
    await first.accepted;
    await secondStepDone.promise;
    while (call < 3) await new Promise((resolve) => setTimeout(resolve, 5));
    send(runtime, 'input-2', 'actually…');
    const terminal = await first.result;
    await runtime.close();

    expect(terminal.reason).toBe('superseded');
    const event = observed.find(
      (candidate) =>
        candidate.type === 'run-terminal' && candidate.terminalReason === 'superseded',
    );
    // Steps one and two finished: 1000+2000 in, 100+200 out, $0.50+$1.00.
    // This used to report 2000/200/$1.00 — the last step wearing the run's name.
    expect(event?.usage?.inputTokens).toEqual({ value: 3_000, provenance: 'computed' });
    expect(event?.usage?.outputTokens).toEqual({ value: 300, provenance: 'computed' });
    expect(event?.usage?.cost).toEqual({
      value: 1.5,
      currency: 'USD',
      provenance: 'computed',
    });
  });
});

describe('a run that never settles still says what it cost', () => {
  test('a stolen lease does not erase the spend that preceded it', async () => {
    const observed: AgentRunEvent[] = [];
    const durable = createMemoryAgentRuntimeStore();
    let stolen = false;
    const store: typeof durable = {
      ...durable,
      async commitRunTerminal(input) {
        if (!stolen) {
          stolen = true;
          // Another actor takes the run back before this executor can settle
          // it. The commit throws, and everything after it used to be skipped.
          const snapshot = await durable.loadSnapshot(input.conversationId);
          const run = snapshot.runs.find((candidate) => candidate.id === input.runId);
          if (run) {
            await durable.recoverRun({
              conversationId: input.conversationId,
              runId: input.runId,
              expectedRevision: run.revision,
              action: 'requeue',
              replaySafe: true,
            });
          }
        }
        return durable.commitRunTerminal(input);
      },
    };
    const runtime = createAgentRuntime({
      protocol: defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}) }),
      store,
      models: {
        resolve: () => ({
          descriptor: {
            provider: 'test',
            modelId: 'expensive-model',
            contextWindow: 100_000,
            capabilities: [],
          },
          model: threeStepModel(),
          normalizeUsage,
        }),
      },
      prompt: () => ({
        instructions: 'test',
        sections: [],
        instructionTokens: { provenance: 'unavailable' },
        contextDecision: 'unavailable',
      }),
      tools: () => ({
        ping: tool({
          description: 'p',
          inputSchema: z.object({}),
          execute: async () => 'pong',
        }),
      }),
      loop: { maxSteps: 10 },
      observe: createAgentObservability({
        write: (event) => {
          observed.push(event);
        },
      }),
    });
    await expect(send(runtime, 'input-1', 'go').result).rejects.toThrow();
    await runtime.close();

    // Three fully billed steps. The run's fate belongs to whoever took it; the
    // three dollars were spent by this executor and are not in doubt.
    const terminals = observed.filter((event) => event.type === 'run-terminal');
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.usage?.cost).toEqual({
      value: 3,
      currency: 'USD',
      provenance: 'computed',
    });
  });

  test('an unsettled report cannot wear the identity of a settled one', async () => {
    const observed: AgentRunEvent[] = [];
    const durable = createMemoryAgentRuntimeStore();
    let settled = false;
    const store: typeof durable = {
      ...durable,
      async commitRunTerminal(input) {
        if (settled) return durable.commitRunTerminal(input);
        settled = true;
        await durable.commitRunTerminal(input);
        const snapshot = await durable.loadSnapshot(input.conversationId);
        return { outcome: 'conflict', actualVersion: snapshot.version };
      },
    };
    const runtime = createAgentRuntime({
      protocol: defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}) }),
      store,
      models: {
        resolve: () => ({
          descriptor: {
            provider: 'test',
            modelId: 'expensive-model',
            contextWindow: 100_000,
            capabilities: [],
          },
          model: threeStepModel(),
          normalizeUsage,
        }),
      },
      prompt: () => ({
        instructions: 'test',
        sections: [],
        instructionTokens: { provenance: 'unavailable' },
        contextDecision: 'unavailable',
      }),
      tools: () => ({
        ping: tool({
          description: 'p',
          inputSchema: z.object({}),
          execute: async () => 'pong',
        }),
      }),
      loop: { maxSteps: 10 },
      observe: createAgentObservability({
        write: (event) => {
          observed.push(event);
        },
      }),
    });
    const result = await send(runtime, 'input-1', 'go').result;
    await runtime.close();

    const terminal = observed.find((event) => event.type === 'run-terminal');
    // The winner's id is `<runId>:terminal:<version>`. A losing executor
    // reporting its own spend must not derive the same string: both read the
    // same post-commit snapshot, and the sink deduplicates stable ids by
    // default, so one of the two spend figures was silently dropped.
    expect(terminal?.eventId).not.toBe(`${result.run.id}:terminal:${result.snapshotVersion}`);
    expect(terminal?.eventId).toContain(result.run.id);
    expect(terminal?.usage?.cost?.value).toBe(3);
  });
});

describe('usage accumulation', () => {
  const step = (input: number, output: number, cost?: number): AgentUsage => ({
    inputTokens: reported(input),
    outputTokens: reported(output),
    ...(cost !== undefined && {
      cost: { value: cost, currency: 'USD', provenance: 'provider-reported' as const },
    }),
  });

  test('a sum is computed, however provider-reported its parts were', () => {
    const total = addUsage(addUsage(undefined, step(1_000, 100, 0.5)), step(2_000, 200, 1));
    expect(total.inputTokens).toEqual({ value: 3_000, provenance: 'computed' });
    expect(total.cost).toEqual({ value: 1.5, currency: 'USD', provenance: 'computed' });
  });

  test('one step is itself, not a sum of one', () => {
    // The first step is passed through untouched, so a single-step run still
    // reports the provider's own number with the provider's own word for it.
    expect(addUsage(undefined, step(1_000, 100, 0.5))).toEqual(step(1_000, 100, 0.5));
  });

  test('a floor is computed whichever step failed to report it', () => {
    // The label must not depend on step order. Returning the reporting side
    // untouched kept `provider-reported` on a total that is really a floor —
    // and a caller filtering on that label to decide what to bill against
    // would have billed a partial sum believing the provider had said it.
    const unknown: AgentUsage = {
      inputTokens: { provenance: 'unavailable' },
      outputTokens: { provenance: 'unavailable' },
      cost: { provenance: 'unavailable' },
    };
    const known = step(1_000, 100, 0.5);
    const unknownFirst = addUsage(addUsage(undefined, unknown), known);
    const knownFirst = addUsage(addUsage(undefined, known), unknown);
    expect(unknownFirst.inputTokens).toEqual({ value: 1_000, provenance: 'computed' });
    expect(knownFirst.inputTokens).toEqual(unknownFirst.inputTokens);
    // Money is not a floor. One step that did not report its cost makes the
    // run's cost unknown, not smaller — nobody bills against a token count.
    expect(unknownFirst.cost).toEqual({ provenance: 'unavailable' });
    expect(knownFirst.cost).toEqual({ provenance: 'unavailable' });
    // Nothing reported at all is still nothing, not a computed zero.
    expect(addUsage(addUsage(undefined, unknown), unknown).inputTokens).toEqual({
      provenance: 'unavailable',
    });
  });

  test('an unknown cost stays unknown however many steps report after it', () => {
    // A floor kept no memory of having been poisoned: `USD 1 → EUR 2 → USD 4`
    // recovered into a confident 4 for a run that really cost $5 and €2.
    const eur: AgentUsage = {
      ...step(1, 1),
      cost: { value: 2, currency: 'EUR', provenance: 'provider-reported' },
    };
    let total = addUsage(undefined, step(1, 1, 1));
    total = addUsage(total, eur);
    expect(total.cost).toEqual({ provenance: 'unavailable' });
    total = addUsage(total, step(1, 1, 4));
    expect(total.cost).toEqual({ provenance: 'unavailable' });
    // The tokens are still countable, and still say they were counted here.
    expect(total.inputTokens).toEqual({ value: 3, provenance: 'computed' });
  });

  test('an unlabelled cost is not assumed to share a currency', () => {
    const usd = step(1, 1, 0.5);
    const unlabelled: AgentUsage = {
      ...step(1, 1),
      cost: { value: 0.5, provenance: 'provider-reported' },
    };
    // Adopting the labelled side's currency would be a conversion by omission.
    expect(addUsage(addUsage(undefined, usd), unlabelled).cost).toEqual({
      provenance: 'unavailable',
    });
  });

  test('a field no step reported stays unavailable instead of becoming zero', () => {
    const total = addUsage(addUsage(undefined, step(1_000, 100)), step(2_000, 200));
    expect(total.cost).toEqual({ provenance: 'unavailable' });
    expect(total.reasoningTokens).toEqual({ provenance: 'unavailable' });
  });

  test('two currencies do not add up, and the total says so rather than picking one', () => {
    const usd = step(1, 1, 0.5);
    const eur: AgentUsage = {
      ...step(1, 1),
      cost: { value: 0.5, currency: 'EUR', provenance: 'provider-reported' },
    };
    // Keeping the first and dropping the second would report a number that is
    // quietly not the total. The core records a currency; it never converts one.
    expect(addUsage(addUsage(undefined, usd), eur).cost).toEqual({
      provenance: 'unavailable',
    });
  });
});

describe('the two event channels are gated for their own readers', () => {
  test('an executor that loses the terminal race still reports what it spent', async () => {
    const observed: AgentRunEvent[] = [];
    const delivered: AgentRuntimeEvent[] = [];
    const durable = createMemoryAgentRuntimeStore();
    let settled = false;
    const store: typeof durable = {
      ...durable,
      async commitRunTerminal(input) {
        if (settled) return durable.commitRunTerminal(input);
        settled = true;
        // Settle the run for real, then answer this executor with a conflict:
        // the retry reloads, finds the run already terminal, and reports
        // `committedByCaller: false` — someone else won.
        await durable.commitRunTerminal(input);
        const snapshot = await durable.loadSnapshot(input.conversationId);
        return { outcome: 'conflict', actualVersion: snapshot.version };
      },
    };
    const runtime = createAgentRuntime({
      protocol: defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}) }),
      store,
      models: {
        resolve: () => ({
          descriptor: {
            provider: 'test',
            modelId: 'expensive-model',
            contextWindow: 100_000,
            capabilities: [],
          },
          model: threeStepModel(),
          normalizeUsage,
        }),
      },
      prompt: () => ({
        instructions: 'test',
        sections: [],
        instructionTokens: { provenance: 'unavailable' },
        contextDecision: 'unavailable',
      }),
      tools: () => ({
        ping: tool({
          description: 'p',
          inputSchema: z.object({}),
          execute: async () => 'pong',
        }),
      }),
      loop: { maxSteps: 10 },
      observe: createAgentObservability({
        write: (event) => {
          observed.push(event);
        },
      }),
      publish: (event) => {
        delivered.push(event);
      },
    });
    await send(runtime, 'input-1', 'go').result;
    await runtime.close();

    // The operator channel reports it: this executor really did spend three
    // dollars, and losing a compare-and-swap does not refund them. Gating this
    // on `committedByCaller` is why such a run used to report nothing at all.
    const terminals = observed.filter((event) => event.type === 'run-terminal');
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.usage?.cost?.value).toBe(3);

    // The delivery channel stays silent, because it carries the assistant
    // message to the application's transport and the winner already delivered
    // it. Reporting spend twice is an operator's problem; delivering a turn
    // twice is the user's.
    expect(delivered.filter((event) => event.type === 'terminal')).toHaveLength(0);
    await runtime.close();
  });
});

describe('a run says who ended it', () => {
  const runtimeFor = (model: MockLanguageModelV4, observed: AgentRunEvent[]) =>
    createAgentRuntime({
      protocol: defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}) }),
      store: createMemoryAgentRuntimeStore(),
      models: {
        resolve: () => ({
          descriptor: {
            provider: 'test',
            modelId: 'expensive-model',
            contextWindow: 100_000,
            capabilities: [],
          },
          model,
          normalizeUsage,
        }),
      },
      prompt: () => ({
        instructions: 'test',
        sections: [],
        instructionTokens: { provenance: 'unavailable' },
        contextDecision: 'unavailable',
      }),
      tools: () => ({}),
      observe: createAgentObservability({
        write: (event) => {
          observed.push(event);
        },
      }),
    });

  test('a provider failure is not a policy stop', async () => {
    const observed: AgentRunEvent[] = [];
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'error', error: new Error('upstream exploded') },
            // The provider still delivers a finish, and this used to overwrite
            // the failure with a stop policy that does not exist.
            {
              type: 'finish',
              finishReason: { unified: 'error', raw: undefined },
              usage: sdkUsage(10, 0),
            },
          ],
        } as never),
      }),
    });
    const runtime = runtimeFor(model, observed);
    const terminal = await send(runtime, 'input-1', 'go').result;
    await runtime.close();

    expect(terminal.reason).toBe('provider_failure');
    expect(terminal.policyName).toBeUndefined();
  });

  test('policy_stop never arrives without the policy that caused it', async () => {
    const observed: AgentRunEvent[] = [];
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'text-start', id: 'text-1' },
            { type: 'text-delta', id: 'text-1', delta: 'truncated…' },
            { type: 'text-end', id: 'text-1' },
            {
              type: 'finish',
              finishReason: { unified: 'length', raw: undefined },
              usage: sdkUsage(10, 5),
            },
          ],
        } as never),
      }),
    });
    const runtime = runtimeFor(model, observed);
    const terminal = await send(runtime, 'input-1', 'go').result;
    await runtime.close();

    // A cap the provider hit is the provider's decision, not the application's.
    expect(terminal.reason).toBe('provider_stop');
    expect(terminal.policyName).toBeUndefined();
    // And the run is still a completed turn — it produced an answer.
    expect(terminal.message.status).toBe('completed');
  });
});

describe('a spend figure outlives the channel that reported it', () => {
  test('the run record carries what it cost, so a dropped event is not a lost number', async () => {
    const dropped: AgentRunEvent[] = [];
    const store = createMemoryAgentRuntimeStore();
    const runtime = createAgentRuntime({
      protocol: defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}) }),
      store,
      models: {
        resolve: () => ({
          descriptor: {
            provider: 'test',
            modelId: 'expensive-model',
            contextWindow: 100_000,
            capabilities: [],
          },
          model: threeStepModel(),
          normalizeUsage,
        }),
      },
      prompt: () => ({
        instructions: 'test',
        sections: [],
        instructionTokens: { provenance: 'unavailable' },
        contextDecision: 'unavailable',
      }),
      tools: () => ({
        ping: tool({
          description: 'p',
          inputSchema: z.object({}),
          execute: async () => 'pong',
        }),
      }),
      loop: { maxSteps: 10 },
      // A sink that loses everything — the bounded default drops under load, and
      // it drops by arrival order, so the event carrying the money is exactly as
      // droppable as the one carrying nothing.
      observe: createAgentObservability({
        write: () => {
          throw new Error('sink is down');
        },
        onSinkError: ({ event }) => {
          if (event) dropped.push(event);
        },
      }),
    });
    const terminal = await send(runtime, 'input-1', 'go').result;
    await runtime.close();

    const snapshot = await store.loadSnapshot('conversation-1');
    const stored = snapshot.runs.find((run) => run.id === terminal.run.id);
    // Readable back from the store, with no event surviving at all.
    expect(stored?.usage?.cost).toEqual({ value: 3, currency: 'USD', provenance: 'computed' });
    expect(stored?.usage?.inputTokens).toEqual({ value: 6_000, provenance: 'computed' });
  });

  test('a crashed attempt leaves behind what it had already spent', async () => {
    const store = createMemoryAgentRuntimeStore();
    // One step finishes and is checkpointed; the process then dies before the
    // terminal commit. Writing usage only at the terminal used to mean the
    // figure lived solely in an event the dead executor never emitted.
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'text-start', id: 'text-1' },
            { type: 'text-delta', id: 'text-1', delta: 'half an answer' },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: undefined },
              usage: sdkUsage(2_000, 200),
              providerMetadata: { openrouter: { usage: { cost: 1.25 } } },
            },
          ],
        } as never),
      }),
    });
    const crashing: typeof store = {
      ...store,
      async commitRunTerminal() {
        throw new Error('process died before the terminal commit');
      },
    };
    const runtime = createAgentRuntime({
      protocol: defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}) }),
      store: crashing,
      models: {
        resolve: () => ({
          descriptor: {
            provider: 'test',
            modelId: 'expensive-model',
            contextWindow: 100_000,
            capabilities: [],
          },
          model,
          normalizeUsage,
        }),
      },
      prompt: () => ({
        instructions: 'test',
        sections: [],
        instructionTokens: { provenance: 'unavailable' },
        contextDecision: 'unavailable',
      }),
      tools: () => ({}),
      loop: { checkpointEveryEvents: 1 },
    });
    await expect(send(runtime, 'input-1', 'go').result).rejects.toThrow();
    await runtime.close();

    const snapshot = await store.loadSnapshot('conversation-1');
    const crashed = snapshot.runs[0];
    // The record the next process reads knows what the dead one had spent.
    expect(crashed?.state).toBe('running');
    // One step, so the provider's own figure passes through untouched — a sum
    // of one is not a sum. The point is that it is *there* at all.
    expect(crashed?.usage?.cost).toEqual({
      value: 1.25,
      currency: 'USD',
      provenance: 'provider-reported',
    });
    expect(crashed?.usage?.inputTokens?.value).toBe(2_000);
  });

  test('what compaction spent is part of what the run spent', async () => {
    const observed: AgentRunEvent[] = [];
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'text-start', id: 'text-1' },
            { type: 'text-delta', id: 'text-1', delta: 'done' },
            { type: 'text-end', id: 'text-1' },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: undefined },
              usage: sdkUsage(1_000, 100),
              providerMetadata: { openrouter: { usage: { cost: 0.25 } } },
            },
          ],
        } as never),
      }),
    });
    const runtime = createAgentRuntime({
      protocol: defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}) }),
      store: createMemoryAgentRuntimeStore(),
      models: {
        resolve: () => ({
          descriptor: {
            provider: 'test',
            modelId: 'expensive-model',
            contextWindow: 100_000,
            capabilities: [],
          },
          model,
          normalizeUsage,
        }),
      },
      prompt: () => ({
        instructions: 'test',
        sections: [],
        instructionTokens: { provenance: 'unavailable' },
        contextDecision: 'unavailable',
      }),
      tools: () => ({}),
      history: {
        // A real provider call the run caused, which produces no step and no
        // event of its own and used to be invisible in every figure.
        compact: async ({ conversationId, store }) => ({
          outcome: 'not_needed' as const,
          snapshot: await store.loadSnapshot(conversationId),
          attempts: 1,
          usage: {
            inputTokens: { value: 400, provenance: 'provider-reported' as const },
            outputTokens: { value: 40, provenance: 'provider-reported' as const },
            cost: { value: 0.75, currency: 'USD', provenance: 'provider-reported' as const },
          },
        }),
      },
      observe: createAgentObservability({
        write: (event) => {
          observed.push(event);
        },
      }),
    });
    const terminal = await send(runtime, 'input-1', 'go').result;
    await runtime.close();

    // $0.75 summarising plus $0.25 answering.
    expect(terminal.metrics?.usage?.cost).toEqual({
      value: 1,
      currency: 'USD',
      provenance: 'computed',
    });
    // The provider reported the run total as 1000 input; compaction's 400 are
    // outside it and the merge keeps them rather than letting the SDK's total
    // erase what the hook reported.
    expect(terminal.metrics?.partial).toBe(false);
  });
});
