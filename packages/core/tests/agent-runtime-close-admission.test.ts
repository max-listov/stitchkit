import { describe, expect, test } from 'bun:test';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import {
  createAgentRuntime,
  createMemoryAgentRuntimeStore,
  defineAgentProtocol,
} from '../src/agent-runtime';

/**
 * `close()` closes admission, and the only proof is the STORE.
 *
 * The defect this file pins is invisible from the caller: `close()` delegated to
 * the coordinator, which refuses to *execute* — and by then `submit()` had run
 * preflight, written a durable input and a queued run, and resolved `accepted`.
 * What is left behind is durable work with no executor, and nothing about it
 * looks different from a crash. So every assertion here reads the snapshot,
 * never just the promise.
 */
function createRuntime(options: { preflight?: () => Promise<void> } = {}) {
  const store = createMemoryAgentRuntimeStore();
  const runtime = createAgentRuntime({
    protocol: defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}) }),
    store,
    models: {
      resolve: () => ({
        descriptor: {
          provider: 'test',
          modelId: 'test-model',
          contextWindow: 1_000,
          capabilities: [],
        },
        model: new MockLanguageModelV4(),
      }),
      ...(options.preflight && { preflight: options.preflight }),
    },
    prompt: () => {
      throw new Error('not used');
    },
    tools: () => ({}),
  });
  return { runtime, store };
}

function anInput(conversationId: string) {
  return {
    conversationId,
    idempotencyKey: `${conversationId}-key`,
    context: {},
    parts: [{ type: 'text' as const, text: 'hello' }],
  };
}

async function runCount(
  store: ReturnType<typeof createMemoryAgentRuntimeStore>,
  conversationId: string,
): Promise<number> {
  const snapshot = await store.loadSnapshot(conversationId);
  return snapshot.runs.length;
}

describe('close() closes admission', () => {
  test('submit after close writes nothing and refuses', async () => {
    const { runtime, store } = createRuntime();
    await runtime.close({ forceTimeoutMs: 1_000 });

    const ticket = runtime.submit(anInput('after-close'));

    await expect(ticket.accepted).rejects.toThrow(/closed and admits no further work/);
    await expect(ticket.result).rejects.toThrow(/closed and admits no further work/);
    // The assertion that matters: no durable run was left for nobody to run.
    expect(await runCount(store, 'after-close')).toBe(0);
  });

  test('resume after close refuses', async () => {
    const { runtime } = createRuntime();
    await runtime.close({ forceTimeoutMs: 1_000 });

    const ticket = runtime.resume({
      conversationId: 'after-close',
      runId: 'run-1',
      context: {},
    });

    await expect(ticket.accepted).rejects.toThrow(/closed and admits no further work/);
    await expect(ticket.result).rejects.toThrow(/closed and admits no further work/);
  });

  test('recover after close refuses', async () => {
    const { runtime } = createRuntime();
    await runtime.close({ forceTimeoutMs: 1_000 });

    await expect(runtime.recover({ resolveContext: () => ({}) })).rejects.toThrow(
      /closed and admits no further work/,
    );
  });

  test('a close arriving inside a preflight still stops the write that follows it', async () => {
    // THE RACE. Entering `submit` before the close is legal; what must not
    // happen is the durable write landing after it. Preflight is a network call
    // to a provider, so this window is as wide as that provider is slow.
    const preflightEntered = Promise.withResolvers<void>();
    const preflightMayFinish = Promise.withResolvers<void>();
    const { runtime, store } = createRuntime({
      preflight: async () => {
        preflightEntered.resolve();
        await preflightMayFinish.promise;
      },
    });

    const ticket = runtime.submit(anInput('mid-preflight'));
    await preflightEntered.promise;

    const closing = runtime.close({ forceTimeoutMs: 1_000 });
    preflightMayFinish.resolve();

    await expect(ticket.accepted).rejects.toThrow(/closed and admits no further work/);
    await closing;
    expect(await runCount(store, 'mid-preflight')).toBe(0);
  });

  test('an admission already written before the close is still executed, not abandoned', async () => {
    // The other side of the same rule: once the durable write has landed there
    // is nothing to refuse, and the coordinator's own drain owns the run.
    // Refusing here would strand exactly the work the gate exists to protect.
    const { runtime, store } = createRuntime();
    const ticket = runtime.submit(anInput('before-close'));
    await ticket.accepted;

    await runtime.close({ gracePeriodMs: 2_000, forceTimeoutMs: 2_000 });

    expect(await runCount(store, 'before-close')).toBe(1);
    const snapshot = await store.loadSnapshot('before-close');
    expect(snapshot.runs[0]?.state).not.toBe('queued');
  });
});
