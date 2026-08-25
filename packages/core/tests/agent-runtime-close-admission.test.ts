import { describe, expect, test } from 'bun:test';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import {
  AgentMessageSchema,
  AgentRunSchema,
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

describe('close() waits for the admissions already inside', () => {
  /**
   * The half the gate cannot see.
   *
   * A submission that passed the closed-check and is INSIDE the durable write
   * owns no coordinator lane yet. A close that drains only the coordinator
   * therefore finds nothing, answers `settled: true, remaining: 0`, and the
   * store commits its queued run afterwards — durable work with no executor,
   * announced as a clean shutdown. The earlier test closes during PREFLIGHT,
   * which is before the write and so never reaches this transition at all.
   */
  function blockingStore(release: Promise<void>, entered: () => void) {
    const durable = createMemoryAgentRuntimeStore();
    const store: typeof durable = {
      ...durable,
      async acceptInputAndAssignRun(input) {
        entered();
        await release;
        return durable.acceptInputAndAssignRun(input);
      },
    };
    return store;
  }

  test('a close during the durable write does not return until the write hands off', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const store = blockingStore(release.promise, entered.resolve);
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
      },
      prompt: () => {
        throw new Error('provider refused');
      },
      tools: () => ({}),
    });

    const ticket = runtime.submit(anInput('closing-mid-write'));
    void ticket.result.catch(() => undefined);
    await entered.promise;

    let settled = false;
    const closing = runtime.close().then((result) => {
      settled = true;
      return result;
    });
    // Nothing may be reported while the store is still writing.
    await Bun.sleep(25);
    expect(settled).toBe(false);

    release.resolve();
    const result = await closing;

    // The admission handed off, so the coordinator owned and drained the run.
    expect(result.remaining).toBe(0);
    expect(result.settled).toBe(true);
    // And the durable run it created did reach a terminal state rather than
    // sitting queued with nobody to execute it.
    const snapshot = await store.loadSnapshot('closing-mid-write');
    expect(snapshot.runs).toHaveLength(1);
    expect(snapshot.runs[0]?.state).not.toBe('queued');
  });

  test('an admission that never hands off is counted, not lost', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const store = blockingStore(release.promise, entered.resolve);
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
      },
      prompt: () => {
        throw new Error('provider refused');
      },
      tools: () => ({}),
    });

    const ticket = runtime.submit(anInput('closing-past-budget'));
    void ticket.result.catch(() => undefined);
    await entered.promise;

    // A force budget is a promise about TIME, so the wait ends — but the answer
    // says what it walked away from instead of calling it settled.
    const result = await runtime.close({ forceTimeoutMs: 20 });
    expect(result.settled).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.remaining).toBeGreaterThanOrEqual(1);
    release.resolve();
  });
});

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

  test('a refused close leaves the runtime open', async () => {
    // Validation used to happen one await later, inside the coordinator: the
    // flag was already set, so the caller got a TypeError AND a runtime that
    // admitted nothing — from a call that never legally started.
    const { runtime, store } = createRuntime();
    await expect(runtime.close({ forceTimeoutMs: Number.NaN })).rejects.toThrow(TypeError);
    await expect(runtime.close({ gracePeriodMs: -1 })).rejects.toThrow(TypeError);

    const ticket = runtime.submit(anInput('still-open'));
    await ticket.accepted;
    expect(await runCount(store, 'still-open')).toBe(1);
    await runtime.close({ forceTimeoutMs: 1_000 });
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

/**
 * Recovery is admission too — the half the gate could not see.
 *
 * `recover()` checks the closed flag on entry and again per page, and both
 * checks are before `decide()`, the caller's own callback. A close arriving
 * INSIDE that callback found no coordinator lane and no in-flight admission,
 * answered `settled: true`, and `recoverRun` then wrote — a durable write after
 * the runtime had said it was done writing.
 */
describe('close() stops recovery mid-item, and waits for the one inside', () => {
  async function orphanedRun(
    conversationId: string,
    runId: string,
    wrap: (store: ReturnType<typeof createMemoryAgentRuntimeStore>) => typeof store = (
      store,
    ) => store,
  ) {
    const durable = createMemoryAgentRuntimeStore();
    const store = wrap(durable);
    const input = AgentMessageSchema.parse({
      schemaVersion: 1,
      id: `${runId}-input`,
      conversationId,
      role: 'user',
      status: 'committed',
      parts: [{ type: 'text', text: 'hello' }],
      createdAt: '2026-08-25T00:00:00.000Z',
      updatedAt: '2026-08-25T00:00:00.000Z',
    });
    const admitted = await store.acceptInputAndAssignRun({
      idempotencyKey: runId,
      input,
      run: AgentRunSchema.parse({
        schemaVersion: 1,
        id: runId,
        conversationId,
        inputMessageIds: [input.id],
        assistantMessageId: `${runId}-assistant`,
        state: 'queued',
        revision: 0,
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
      }),
    });
    if (admitted.outcome !== 'applied') throw new Error('fixture admission failed');
    const run = admitted.snapshot.runs.find((candidate) => candidate.id === runId);
    if (!run) throw new Error('fixture run missing');
    // Acquired by an owner that is gone: `running`, with nothing executing it.
    await store.acquireRun({
      conversationId,
      runId,
      expectedRevision: run.revision,
      ownerId: 'crashed-owner',
    });
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
      },
      prompt: () => {
        throw new Error('must not execute');
      },
      tools: () => ({}),
    });
    return { store, runtime };
  }

  async function stateOf(
    store: ReturnType<typeof createMemoryAgentRuntimeStore>,
    conversationId: string,
    runId: string,
  ): Promise<string | undefined> {
    const snapshot = await store.loadSnapshot(conversationId);
    return snapshot.runs.find((run) => run.id === runId)?.state;
  }

  test('a close inside decide() stops the requeue that would have followed it', async () => {
    // THE RACE. `decide` is the caller's callback — a database read, a policy
    // service, anything slow — and the durable write is on the other side of it.
    const { store, runtime } = await orphanedRun('recovering', 'orphan');
    const deciding = Promise.withResolvers<void>();
    const mayDecide = Promise.withResolvers<void>();

    const recovering = runtime.recover({
      resolveContext: () => ({}),
      decide: async () => {
        deciding.resolve();
        await mayDecide.promise;
        return { action: 'requeue', replaySafe: true };
      },
    });
    await deciding.promise;

    const closing = runtime.close({ forceTimeoutMs: 1_000 });
    mayDecide.resolve();

    const outcomes = await recovering;
    await closing;

    expect(outcomes).toEqual([
      {
        conversationId: 'recovering',
        runId: 'orphan',
        outcome: 'failed',
        error: expect.objectContaining({
          message: expect.stringContaining('closed and admits no further work'),
        }),
      },
    ]);
    // The proof that matters is the STORE: nothing moved.
    expect(await stateOf(store, 'recovering', 'orphan')).toBe('running');
  });

  test('a close does not return while a recovery write is in flight', async () => {
    // The window the flag alone cannot close. Between the check and the write
    // there is no await — but the WRITE itself is one, and a close that only
    // drains the coordinator finds no lane for it. It answered `settled` and
    // the store committed afterwards: the same shape as the submit race, one
    // entry point along.
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let written = false;
    const { store, runtime } = await orphanedRun('writing', 'orphan', (durable) => ({
      ...durable,
      async recoverRun(input) {
        entered.resolve();
        await release.promise;
        const result = await durable.recoverRun(input);
        written = true;
        return result;
      },
    }));

    const recovering = runtime.recover({
      decide: () => ({ action: 'requeue', replaySafe: true }),
      resolveContext: () => ({}),
    });
    await entered.promise;

    const closing = runtime.close({ forceTimeoutMs: 1_000 });
    release.resolve();
    await closing;

    // Not "the write eventually happened" — that it had ALREADY happened by the
    // time close answered. Without the barrier this is false.
    expect(written).toBeTrue();
    await recovering;
    // Requeued before the close, and left where recovery found it rather than
    // executed by a runtime that is shutting down.
    expect(await stateOf(store, 'writing', 'orphan')).toBe('queued');
  });
});
