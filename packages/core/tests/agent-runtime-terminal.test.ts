import { describe, expect, test } from 'bun:test';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import {
  type AgentRun,
  type AgentRunEvent,
  type AgentRuntimeEvent,
  createAgentObservability,
  createAgentRuntime,
  createMemoryAgentRuntimeStore,
  defineAgentProtocol,
} from '../src/agent-runtime';

function submitAfterTerminalConflictWithOwnershipDrift(drift: 'owner' | 'fencing') {
  const durable = createMemoryAgentRuntimeStore();
  let terminalConflictSeen = false;
  const drifted = (run: AgentRun): AgentRun =>
    drift === 'owner'
      ? { ...run, ownerId: 'replacement-runtime' }
      : { ...run, fencingToken: (run.fencingToken ?? 0) + 1 };
  const store: typeof durable = {
    ...durable,
    async commitRunTerminal(input) {
      terminalConflictSeen = true;
      const snapshot = await durable.loadSnapshot(input.conversationId);
      return { outcome: 'conflict', actualVersion: snapshot.version };
    },
    // Both reads drift, because the drift is a fact about the record and not
    // about which call asks for it. The terminal path reads `loadRun` now; when
    // only `loadSnapshot` drifted, the retry loop saw an unchanged owner every
    // time and spun forever against a commit that always conflicts.
    async loadSnapshot(conversationId) {
      const snapshot = await durable.loadSnapshot(conversationId);
      if (!terminalConflictSeen) return snapshot;
      return { ...snapshot, runs: snapshot.runs.map(drifted) };
    },
    async loadRun(input) {
      const view = await durable.loadRun(input);
      if (!view || !terminalConflictSeen) return view;
      return { ...view, run: drifted(view.run) };
    },
  };
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
      throw new Error('terminalize fixture');
    },
    tools: () => ({}),
  });
  return runtime.submit({
    conversationId: `terminal-${drift}-drift`,
    idempotencyKey: 'input-1',
    context: {},
    parts: [{ type: 'text', text: 'hello' }],
    metadata: {},
  }).result;
}

describe('agent runtime terminalization', () => {
  test('preflights model capability before durable input admission', async () => {
    const store = createMemoryAgentRuntimeStore();
    const runtime = createAgentRuntime({
      protocol: defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}) }),
      store,
      models: {
        preflight: () => {
          throw new Error('required capability unavailable');
        },
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
      prompt: () => ({
        instructions: '',
        sections: [],
        instructionTokens: { provenance: 'unavailable' },
        contextDecision: 'unavailable',
      }),
      tools: () => ({}),
    });
    const ticket = runtime.submit({
      conversationId: 'conversation-preflight',
      idempotencyKey: 'request-preflight',
      context: {},
      parts: [{ type: 'text', text: 'hello' }],
      metadata: {},
    });
    void ticket.result.catch(() => undefined);
    void ticket.admission.catch(() => undefined);

    await expect(ticket.accepted).rejects.toThrow('required capability unavailable');
    expect((await store.loadSnapshot('conversation-preflight')).messages).toHaveLength(0);
  });

  test('commits a provider failure when prompt construction fails before streaming', async () => {
    const store = createMemoryAgentRuntimeStore();
    const events: AgentRuntimeEvent[] = [];
    const failure = new Error('internal provider setup failed');
    const runtime = createAgentRuntime({
      protocol: defineAgentProtocol({
        context: z.object({}),
        inputMetadata: z.object({ channel: z.literal('test') }),
      }),
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
        throw failure;
      },
      tools: () => ({}),
      publish: (event) => {
        events.push(event);
      },
      generateId: (() => {
        let id = 0;
        return () => `id-${++id}`;
      })(),
      now: () => new Date('2026-08-22T00:00:00.000Z'),
    });

    const ticket = runtime.submit({
      conversationId: 'conversation-1',
      idempotencyKey: 'input-1',
      context: {},
      parts: [{ type: 'text', text: 'hello' }],
      metadata: { channel: 'test' },
    });
    await ticket.accepted;
    const terminal = await ticket.result;

    expect(terminal.reason).toBe('provider_failure');
    expect(terminal.run.state).toBe('failed');
    expect(terminal.message.status).toBe('failed');
    const snapshot = await store.loadSnapshot('conversation-1');
    expect(snapshot.runs).toHaveLength(1);
    expect(snapshot.runs[0]?.terminalReason).toBe('provider_failure');
    expect(snapshot.messages[0]?.metadata).toEqual({ channel: 'test' });
    const terminalEvent = events.find((event) => event.type === 'terminal');
    // `partial` now says something about the run rather than which event kind
    // you are holding: the provider never reported this run finished, so the
    // figure beside it is not a confirmed total. It is also not a zero — the
    // call may never have been made, and we cannot prove it either way.
    const metrics = terminalEvent?.type === 'terminal' ? terminalEvent.metrics : undefined;
    expect(metrics?.partial).toBe(true);
    expect(metrics?.usage?.cost).toEqual({ provenance: 'unavailable' });
  });

  test('coalesces inputs behind an active run into one durable successor', async () => {
    const store = createMemoryAgentRuntimeStore();
    const promptEntered = Promise.withResolvers<void>();
    const releasePrompt = Promise.withResolvers<void>();
    let promptCalls = 0;
    const runtime = createAgentRuntime({
      protocol: defineAgentProtocol({
        context: z.object({}),
        inputMetadata: z.object({}),
      }),
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
      prompt: async () => {
        promptCalls += 1;
        if (promptCalls === 1) {
          promptEntered.resolve();
          await releasePrompt.promise;
        }
        throw new Error('stop after admission probe');
      },
      tools: () => ({}),
      runs: { coalescePending: true },
    });
    const submit = (idempotencyKey: string, text: string) =>
      runtime.submit({
        conversationId: 'conversation-1',
        idempotencyKey,
        context: {},
        parts: [{ type: 'text', text }],
        metadata: {},
      });

    const first = submit('input-1', 'one');
    await first.accepted;
    await promptEntered.promise;
    const second = submit('input-2', 'two');
    const third = submit('input-3', 'three');
    await Promise.all([second.accepted, third.accepted]);

    const [secondAdmission, thirdAdmission] = await Promise.all([
      second.admission,
      third.admission,
    ]);
    expect(secondAdmission.runId).toBe(thirdAdmission.runId);
    expect(secondAdmission.assistantMessageId).toBe(thirdAdmission.assistantMessageId);
    expect(secondAdmission.snapshotVersion).toBeLessThan(thirdAdmission.snapshotVersion);

    const queued = await store.loadSnapshot('conversation-1');
    expect(queued.runs).toHaveLength(2);
    // By identity, not by position. Reading position 1 as "the successor" is
    // what made this test fail a release gate on a runtime that was doing
    // exactly the right thing: both runs are created inside one millisecond,
    // so the tie fell to a random identifier and half the time named the
    // active run instead.
    const successor = queued.runs.find((run) => run.id === secondAdmission.runId);
    expect(successor?.inputMessageIds).toHaveLength(2);
    expect(successor?.state).toBe('queued');
    // And the order the snapshot promises is checked as its own statement.
    expect(queued.runs.map((run) => run.id)).toEqual([
      (await first.admission).runId,
      secondAdmission.runId,
    ]);
    releasePrompt.resolve();
    await Promise.all([first.result, second.result, third.result]);
    expect(promptCalls).toBe(2);
    expect((await second.result).run.id).toBe((await third.result).run.id);
  });

  test('settles an interrupt racing provider completion and runs three coalesced inputs', async () => {
    const durable = createMemoryAgentRuntimeStore();
    const terminalEntered = Promise.withResolvers<void>();
    const releaseTerminal = Promise.withResolvers<void>();
    const terminalRetryEntered = Promise.withResolvers<void>();
    const releaseTerminalRetry = Promise.withResolvers<void>();
    let terminalCalls = 0;
    const store: typeof durable = {
      ...durable,
      async commitRunTerminal(input) {
        terminalCalls += 1;
        if (terminalCalls === 1) {
          terminalEntered.resolve();
          await releaseTerminal.promise;
        }
        if (terminalCalls === 2) {
          terminalRetryEntered.resolve();
          await releaseTerminalRetry.promise;
          const snapshot = await durable.loadSnapshot(input.conversationId);
          return { outcome: 'conflict', actualVersion: snapshot.version };
        }
        return durable.commitRunTerminal(input);
      },
    };
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: undefined },
              usage: {
                inputTokens: {
                  total: 1,
                  noCache: 1,
                  cacheRead: undefined,
                  cacheWrite: undefined,
                },
                outputTokens: { total: 1, text: 1, reasoning: undefined },
              },
            },
          ],
        }),
      }),
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
          model,
        }),
      },
      prompt: () => ({
        instructions: '',
        sections: [],
        instructionTokens: { provenance: 'unavailable' },
        contextDecision: 'unavailable',
      }),
      tools: () => ({}),
      runs: { coalescePending: true },
    });
    const submit = (idempotencyKey: string) =>
      runtime.submit({
        conversationId: 'terminal-interrupt-race',
        idempotencyKey,
        context: {},
        parts: [{ type: 'text', text: idempotencyKey }],
        metadata: {},
      });

    const first = submit('input-1');
    await first.accepted;
    const firstAdmission = await first.admission;
    await terminalEntered.promise;
    const interrupted = await runtime.interrupt({
      conversationId: 'terminal-interrupt-race',
      runId: firstAdmission.runId,
    });
    expect(interrupted.outcome).toBe('applied');

    const successors = [submit('input-2')];
    await successors[0]?.accepted;
    releaseTerminal.resolve();
    await terminalRetryEntered.promise;
    successors.push(submit('input-3'), submit('input-4'));
    await Promise.all(successors.slice(1).map((ticket) => ticket.accepted));
    const successorAdmissions = await Promise.all(
      successors.map((ticket) => ticket.admission),
    );
    expect(new Set(successorAdmissions.map((admission) => admission.runId)).size).toBe(1);

    releaseTerminalRetry.resolve();
    const predecessor = await first.result;
    const successorResults = await Promise.all(successors.map((ticket) => ticket.result));
    expect(predecessor.reason).toBe('interrupted');
    expect(predecessor.run.state).toBe('interrupted');
    expect(predecessor.message.status).toBe('interrupted');
    expect(new Set(successorResults.map((result) => result.run.id)).size).toBe(1);
    expect(successorResults[0]?.run.inputMessageIds).toHaveLength(3);
    expect(terminalCalls).toBe(4);

    const snapshot = await store.loadSnapshot('terminal-interrupt-race');
    expect(snapshot.runs.map((run) => run.state)).toEqual(['interrupted', 'completed']);
  });

  test('settles from the canonical terminal snapshot when another terminal CAS wins', async () => {
    const durable = createMemoryAgentRuntimeStore();
    const events: AgentRuntimeEvent[] = [];
    const operatorEvents: AgentRunEvent[] = [];
    const observability = createAgentObservability({
      write: (event) => {
        operatorEvents.push(event);
      },
    });
    let loseFirstTerminalCas = true;
    const store: typeof durable = {
      ...durable,
      async commitRunTerminal(input) {
        if (!loseFirstTerminalCas) return durable.commitRunTerminal(input);
        loseFirstTerminalCas = false;
        const winner = await durable.commitRunTerminal(input);
        if (winner.outcome !== 'applied') return winner;
        return { outcome: 'conflict', actualVersion: winner.snapshot.version };
      },
    };
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
        throw new Error('terminalize fixture');
      },
      tools: () => ({}),
      publish: (event) => {
        events.push(event);
      },
      observe: observability,
    });

    const result = await runtime.submit({
      conversationId: 'terminal-cas-winner',
      idempotencyKey: 'input-1',
      context: {},
      parts: [{ type: 'text', text: 'hello' }],
      metadata: {},
    }).result;

    expect(result.reason).toBe('provider_failure');
    expect(result.run.state).toBe('failed');
    expect(result.message.status).toBe('failed');
    expect(result.metrics).toBeUndefined();
    // The delivery channel stays silent: the winner already delivered the turn,
    // and publishing it again would deliver it twice.
    expect(events.filter((event) => event.type === 'terminal')).toHaveLength(0);
    await observability.flush();
    // The operator channel does not. This executor ran and spent whatever it
    // spent, and losing a compare-and-swap does not refund it — a spend record
    // that omits every run terminated by someone else is not a spend record.
    const operatorTerminals = operatorEvents.filter((event) => event.type === 'run-terminal');
    expect(operatorTerminals).toHaveLength(1);
    expect(operatorTerminals[0]?.usage).toBeDefined();
    await observability.close();
  });

  test('uses a duplicate terminal result as canonical without republishing it', async () => {
    const durable = createMemoryAgentRuntimeStore();
    const events: AgentRuntimeEvent[] = [];
    const store: typeof durable = {
      ...durable,
      async commitRunTerminal(input) {
        const interruptedAssistant = {
          ...input.assistant,
          status: 'interrupted',
          parts: [{ type: 'control', reason: 'run-interrupted' }],
        } satisfies typeof input.assistant;
        const winner = await durable.commitRunTerminal({
          ...input,
          assistant: interruptedAssistant,
          reason: 'interrupted',
        });
        if (winner.outcome !== 'applied') return winner;
        const run = winner.snapshot.runs.find((candidate) => candidate.id === input.runId);
        const canonicalInput = winner.snapshot.messages.find(
          (message) => message.role === 'user',
        );
        const canonicalAssistant = winner.snapshot.messages.find(
          (message) => message.id === input.assistant.id,
        );
        if (!run || !canonicalInput || !canonicalAssistant)
          throw new Error('fixture projection missing');
        const assistant = {
          ...canonicalAssistant,
          id: 'non-canonical-retained-assistant',
        };
        return {
          outcome: 'duplicate',
          input: canonicalInput,
          inputMessageId: canonicalInput.id,
          runId: run.id,
          assistantMessageId: run.assistantMessageId,
          run,
          assistant,
          snapshot: winner.snapshot,
        };
      },
    };
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
        throw new Error('local candidate must lose');
      },
      tools: () => ({}),
      publish: (event) => {
        events.push(event);
      },
    });

    const result = await runtime.submit({
      conversationId: 'terminal-duplicate-winner',
      idempotencyKey: 'input-1',
      context: {},
      parts: [{ type: 'text', text: 'hello' }],
      metadata: {},
    }).result;

    expect(result.reason).toBe('interrupted');
    expect(result.run.state).toBe('interrupted');
    expect(result.message.id).not.toBe('non-canonical-retained-assistant');
    expect(result.message.status).toBe('interrupted');
    expect(result.metrics).toBeUndefined();
    expect(events.filter((event) => event.type === 'terminal')).toHaveLength(0);
  });

  test('rejects a malformed retained terminal projection after compaction', async () => {
    const durable = createMemoryAgentRuntimeStore();
    const store: typeof durable = {
      ...durable,
      async commitRunTerminal(input) {
        const winner = await durable.commitRunTerminal(input);
        if (winner.outcome !== 'applied') return winner;
        const run = winner.snapshot.runs.find((candidate) => candidate.id === input.runId);
        const canonicalInput = winner.snapshot.messages.find(
          (message) => message.role === 'user',
        );
        const assistant = winner.snapshot.messages.find(
          (message) => message.id === input.assistant.id,
        );
        if (!run || !canonicalInput || !assistant)
          throw new Error('fixture projection missing');
        return {
          outcome: 'duplicate',
          input: canonicalInput,
          inputMessageId: canonicalInput.id,
          runId: run.id,
          assistantMessageId: run.assistantMessageId,
          run,
          assistant: { ...assistant, status: 'streaming' },
          snapshot: {
            ...winner.snapshot,
            messages: winner.snapshot.messages.filter(
              (message) => message.id !== run.assistantMessageId,
            ),
          },
        };
      },
    };
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
        throw new Error('terminalize fixture');
      },
      tools: () => ({}),
    });

    await expect(
      runtime.submit({
        conversationId: 'terminal-malformed-retained-assistant',
        idempotencyKey: 'input-1',
        context: {},
        parts: [{ type: 'text', text: 'hello' }],
        metadata: {},
      }).result,
    ).rejects.toThrow('terminal result projection');
  });

  test('retries a terminal CAS conflict while ownership remains current', async () => {
    const durable = createMemoryAgentRuntimeStore();
    let terminalCalls = 0;
    const store: typeof durable = {
      ...durable,
      async commitRunTerminal(input) {
        terminalCalls += 1;
        if (terminalCalls > 1) return durable.commitRunTerminal(input);
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
            modelId: 'test-model',
            contextWindow: 1_000,
            capabilities: [],
          },
          model: new MockLanguageModelV4(),
        }),
      },
      prompt: () => {
        throw new Error('terminalize fixture');
      },
      tools: () => ({}),
    });

    const result = await runtime.submit({
      conversationId: 'terminal-head-cas-conflict',
      idempotencyKey: 'input-1',
      context: {},
      parts: [{ type: 'text', text: 'hello' }],
      metadata: {},
    }).result;

    expect(terminalCalls).toBe(2);
    expect(result.run.state).toBe('failed');
  });

  test('rejects terminal reconciliation after ownership changes', async () => {
    await expect(submitAfterTerminalConflictWithOwnershipDrift('owner')).rejects.toThrow(
      'terminal commit',
    );
  });

  test('rejects terminal reconciliation after the fencing token changes', async () => {
    await expect(submitAfterTerminalConflictWithOwnershipDrift('fencing')).rejects.toThrow(
      'terminal commit',
    );
  });

  test('accepts caller record ids and exposes the assigned admission identity', async () => {
    const store = createMemoryAgentRuntimeStore();
    const events: AgentRuntimeEvent[] = [];
    const runtime = createAgentRuntime({
      protocol: defineAgentProtocol({
        context: z.object({}),
        inputMetadata: z.object({}),
      }),
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
        throw new Error('stop after admission probe');
      },
      tools: () => ({}),
      publish: (event) => {
        events.push(event);
      },
    });

    const ticket = runtime.submit({
      conversationId: 'conversation-1',
      idempotencyKey: 'request-1',
      context: {},
      parts: [{ type: 'text', text: 'hello' }],
      metadata: {},
      recordIds: {
        inputMessageId: 'product-user-1',
        runId: 'product-run-1',
        assistantMessageId: 'product-assistant-1',
      },
    });

    await ticket.accepted;
    expect(await ticket.admission).toMatchObject({
      inputMessageId: 'product-user-1',
      runId: 'product-run-1',
      assistantMessageId: 'product-assistant-1',
      snapshotVersion: 1,
      input: { id: 'product-user-1', role: 'user' },
      run: { id: 'product-run-1', assistantMessageId: 'product-assistant-1' },
      assistant: { id: 'product-assistant-1', status: 'pending' },
    });
    expect(events.find((event) => event.type === 'admission')).toMatchObject({
      input: { id: 'product-user-1' },
      run: { id: 'product-run-1' },
      assistant: { id: 'product-assistant-1', status: 'pending' },
    });
    const snapshot = await store.loadSnapshot('conversation-1');
    expect(snapshot.messages[0]?.id).toBe('product-user-1');
    expect(snapshot.runs[0]?.assistantMessageId).toBe('product-assistant-1');
    await ticket.result;
  });

  test('returns the durable admission identity for a duplicate with discarded proposals', async () => {
    const store = createMemoryAgentRuntimeStore();
    const events: AgentRuntimeEvent[] = [];
    const runtime = createAgentRuntime({
      protocol: defineAgentProtocol({
        context: z.object({}),
        inputMetadata: z.object({}),
      }),
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
        throw new Error('stop after admission probe');
      },
      tools: () => ({}),
      publish: (event) => {
        events.push(event);
      },
    });

    const first = runtime.submit({
      conversationId: 'conversation-1',
      idempotencyKey: 'request-1',
      context: {},
      parts: [{ type: 'text', text: 'hello' }],
      metadata: {},
      recordIds: {
        inputMessageId: 'product-user-1',
        runId: 'product-run-1',
        assistantMessageId: 'product-assistant-1',
      },
    });
    const firstResult = await first.result;
    const beforeCompaction = await store.loadSnapshot('conversation-1');
    const compacted = await store.replaceCompactedRange({
      conversationId: 'conversation-1',
      expectedVersion: beforeCompaction.version,
      replacedMessageIds: ['product-user-1', 'product-assistant-1'],
      summary: {
        schemaVersion: 1,
        id: 'summary-1',
        conversationId: 'conversation-1',
        role: 'summary',
        status: 'committed',
        parts: [{ type: 'text', text: 'compacted' }],
        createdAt: '2026-08-23T00:00:00.000Z',
        updatedAt: '2026-08-23T00:00:00.000Z',
      },
    });
    expect(compacted.outcome).toBe('applied');

    const duplicate = runtime.submit({
      conversationId: 'conversation-1',
      idempotencyKey: 'request-1',
      context: {},
      parts: [{ type: 'text', text: 'hello' }],
      metadata: {},
      recordIds: {
        inputMessageId: 'product-user-1',
        runId: 'discarded-run',
        assistantMessageId: 'discarded-assistant',
      },
    });

    const duplicateAdmission = await duplicate.admission;
    const duplicateSnapshot = await store.loadSnapshot('conversation-1');
    expect(duplicateAdmission).toMatchObject({
      inputMessageId: 'product-user-1',
      runId: 'product-run-1',
      assistantMessageId: 'product-assistant-1',
      snapshotVersion: duplicateSnapshot.version,
      input: { id: 'product-user-1', role: 'user' },
      assistant: {
        id: 'product-assistant-1',
        role: 'assistant',
        status: 'failed',
      },
    });
    const duplicateResult = await duplicate.result;
    expect(duplicateResult.run.id).toBe('product-run-1');
    expect(duplicateResult.message).toEqual(firstResult.message);
    expect(events.filter((event) => event.type === 'admission').at(-1)).toMatchObject({
      assistant: {
        id: 'product-assistant-1',
        role: 'assistant',
        status: 'failed',
      },
    });
  });

  test('reports a persistence contract violation when a terminal duplicate lost its assistant', async () => {
    const durable = createMemoryAgentRuntimeStore();
    const store: typeof durable = {
      ...durable,
      async acceptInputAndAssignRun(input) {
        const result = await durable.acceptInputAndAssignRun(input);
        if (result.outcome !== 'duplicate') return result;
        const { assistant: _lostAssistant, ...withoutAssistant } = result;
        return withoutAssistant;
      },
    };
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
        throw new Error('terminalize fixture');
      },
      tools: () => ({}),
    });
    await runtime.submit({
      conversationId: 'missing-retained-assistant',
      idempotencyKey: 'request-1',
      context: {},
      parts: [{ type: 'text', text: 'first' }],
      metadata: {},
    }).result;

    const duplicate = runtime.submit({
      conversationId: 'missing-retained-assistant',
      idempotencyKey: 'request-1',
      context: {},
      parts: [{ type: 'text', text: 'duplicate' }],
      metadata: {},
    });
    await expect(duplicate.result).rejects.toThrow(
      'Duplicate terminal admission has no retained canonical assistant',
    );
  });

  test('keeps runtime tickets distinct for delimiter-bearing identities', async () => {
    const store = createMemoryAgentRuntimeStore();
    const runtime = createAgentRuntime({
      protocol: defineAgentProtocol({
        context: z.object({}),
        inputMetadata: z.object({}),
      }),
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
        throw new Error('stop after admission probe');
      },
      tools: () => ({}),
    });

    const first = runtime.submit({
      conversationId: 'a\u0000b',
      idempotencyKey: 'c',
      context: {},
      parts: [{ type: 'text', text: 'one' }],
      metadata: {},
      recordIds: {
        inputMessageId: 'input-1',
        runId: 'run-1',
        assistantMessageId: 'assistant-1',
      },
    });
    const second = runtime.submit({
      conversationId: 'a',
      idempotencyKey: 'b\u0000c',
      context: {},
      parts: [{ type: 'text', text: 'two' }],
      metadata: {},
      recordIds: {
        inputMessageId: 'input-2',
        runId: 'run-2',
        assistantMessageId: 'assistant-2',
      },
    });

    const [firstAdmission, secondAdmission] = await Promise.all([
      first.admission,
      second.admission,
    ]);
    expect(firstAdmission.runId).toBe('run-1');
    expect(secondAdmission.runId).toBe('run-2');
    await Promise.all([first.result, second.result]);
  });

  test('internally observes admission rejection for accepted-result compatibility', async () => {
    const runtime = createAgentRuntime({
      protocol: defineAgentProtocol({
        context: z.object({}),
        inputMetadata: z.object({}),
      }),
      store: {
        loadSnapshot: () => Promise.reject(new Error('not used')),
        loadRun: () => Promise.reject(new Error('not used')),
        listActiveRuns: () => Promise.reject(new Error('not used')),
        acceptInputAndAssignRun: () => Promise.reject(new Error('admission failed')),
        acquireRun: () => Promise.reject(new Error('not used')),
        checkpointRunAssistant: () => Promise.reject(new Error('not used')),
        requestRunInterrupt: () => Promise.reject(new Error('not used')),
        recoverRun: () => Promise.reject(new Error('not used')),
        commitRunTerminal: () => Promise.reject(new Error('not used')),
        replaceCompactedRange: () => Promise.reject(new Error('not used')),
        scanRecoverable: () => Promise.reject(new Error('not used')),
      },
      models: {
        resolve: () => {
          throw new Error('not used');
        },
      },
      prompt: () => {
        throw new Error('not used');
      },
      tools: () => ({}),
    });

    const ticket = runtime.submit({
      conversationId: 'conversation-1',
      idempotencyKey: 'request-1',
      context: {},
      parts: [{ type: 'text', text: 'hello' }],
      metadata: {},
    });
    const failures = await Promise.allSettled([ticket.accepted, ticket.result]);
    expect(failures.map((failure) => failure.status)).toEqual(['rejected', 'rejected']);
    await Bun.sleep(0);
  });
});
