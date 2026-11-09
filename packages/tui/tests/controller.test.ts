import { describe, expect, test } from 'bun:test';
import {
  AgentModelCatalogSchema,
  type AgentRuntimeInput,
  type AgentSnapshot,
  AgentSnapshotSchema,
  createMemoryAgentModelSelectionStore,
} from 'stitchkit/agent-runtime';
import type {
  AgentHarnessApprovalDecision,
  AgentHarnessPendingApproval,
  HeadlessAgentHarness,
} from 'stitchkit/agent-runtime/harness';
import { createAgentTuiController } from '../src/controller';

const observedAt = '2026-08-30T00:00:00.000Z';

const catalog = AgentModelCatalogSchema.parse({
  schemaVersion: 1,
  source: 'fixture',
  observedAt,
  completeness: 'complete',
  diagnostics: [],
  models: ['model-a', 'model-b'].map((id) => ({
    id,
    name: id,
    descriptor: {
      provider: 'fixture',
      modelId: id,
      contextWindow: 32_000,
      capabilities: ['tools'],
    },
    metrics: [],
  })),
});

function emptySnapshot(conversationId: string): AgentSnapshot {
  return AgentSnapshotSchema.parse({
    schemaVersion: 1,
    conversationId,
    version: 0,
    messages: [],
    runs: [],
  });
}

function pinnedSnapshot(modelId: string): AgentSnapshot {
  return AgentSnapshotSchema.parse({
    schemaVersion: 1,
    conversationId: 'main',
    version: 2,
    messages: [
      {
        schemaVersion: 1,
        id: 'input-1',
        conversationId: 'main',
        runId: 'run-1',
        role: 'user',
        status: 'committed',
        parts: [{ type: 'text', text: 'continue' }],
        metadata: { modelId },
        createdAt: observedAt,
        updatedAt: observedAt,
      },
    ],
    runs: [
      {
        schemaVersion: 1,
        id: 'run-1',
        conversationId: 'main',
        inputMessageIds: ['input-1'],
        assistantMessageId: 'assistant-1',
        state: 'running',
        revision: 1,
        ownerId: 'fixture-owner',
        fencingToken: 1,
        createdAt: observedAt,
        updatedAt: observedAt,
      },
    ],
  });
}

function fakeHarness(input?: {
  snapshot?: AgentSnapshot;
  approval?: AgentHarnessPendingApproval;
  snapshotFor?(conversationId: string): Promise<AgentSnapshot>;
}) {
  const submissions: AgentRuntimeInput[] = [];
  const approvalDecisions: AgentHarnessApprovalDecision[] = [];
  const harness: HeadlessAgentHarness<Record<string, never>> = {
    submit(value) {
      submissions.push(value);
      throw new Error('fixture stopped after capturing submit');
    },
    resume() {
      throw new Error('fixture does not resume');
    },
    async interrupt() {
      throw new Error('fixture does not interrupt');
    },
    async abandon() {
      throw new Error('fixture does not abandon');
    },
    async recover() {
      return [];
    },
    stop() {
      return false;
    },
    async close() {
      return { settled: true, timedOut: false, remaining: 0 };
    },
    async snapshot(conversationId) {
      if (input?.snapshotFor) return input.snapshotFor(conversationId);
      return input?.snapshot?.conversationId === conversationId
        ? input.snapshot
        : emptySnapshot(conversationId);
    },
    subscribe() {
      return () => undefined;
    },
    async pendingApprovals(conversationId) {
      return input?.approval?.conversationId === conversationId ? [input.approval] : [];
    },
    async respondToApproval(value) {
      approvalDecisions.push(value);
      throw new Error('fixture stopped after capturing approval');
    },
  };
  return { harness, submissions, approvalDecisions };
}

describe('Agent TUI controller model selection', () => {
  test('keeps selections isolated per conversation and applies changes to the next submit', async () => {
    const fixture = fakeHarness();
    const selections = createMemoryAgentModelSelectionStore();
    const controller = await createAgentTuiController({
      harness: fixture.harness,
      catalog,
      selections,
      conversationId: 'one',
      context: () => ({}),
    });

    await controller.selectModel('model-a');
    await expect(controller.submit('first')).rejects.toThrow('capturing submit');
    await controller.switchConversation('two');
    await controller.selectModel('model-b');
    await expect(controller.submit('second')).rejects.toThrow('capturing submit');
    await controller.switchConversation('one');
    await expect(controller.submit('third')).rejects.toThrow('capturing submit');

    expect(
      fixture.submissions.map(({ conversationId, metadata }) => [conversationId, metadata]),
    ).toEqual([
      ['one', { modelId: 'model-a' }],
      ['two', { modelId: 'model-b' }],
      ['one', { modelId: 'model-a' }],
    ]);
    await controller.close();
  });

  test('continues an approval with the model pinned in durable run evidence', async () => {
    const fixture = fakeHarness({
      snapshot: pinnedSnapshot('model-a'),
      approval: {
        conversationId: 'main',
        runId: 'run-1',
        messageId: 'assistant-1',
        approvalId: 'approval-1',
        callId: 'call-1',
        toolName: 'edit_file',
        input: { path: 'README.md' },
      },
    });
    const selections = createMemoryAgentModelSelectionStore();
    await selections.save('main', { modelId: 'model-b', selectedAt: observedAt });
    const controller = await createAgentTuiController({
      harness: fixture.harness,
      catalog,
      selections,
      conversationId: 'main',
      context: () => ({}),
    });

    await expect(controller.respondToApproval(true)).rejects.toThrow('capturing approval');
    expect(fixture.approvalDecisions[0]?.metadata).toEqual({ modelId: 'model-a' });
    await controller.close();
  });

  test('discards a slower conversation switch after a newer identity wins', async () => {
    let releaseSlow: ((snapshot: AgentSnapshot) => void) | undefined;
    const slow = new Promise<AgentSnapshot>((resolve) => {
      releaseSlow = resolve;
    });
    const fixture = fakeHarness({
      snapshotFor: (conversationId) =>
        conversationId === 'slow' ? slow : Promise.resolve(emptySnapshot(conversationId)),
    });
    const controller = await createAgentTuiController({
      harness: fixture.harness,
      catalog,
      selections: createMemoryAgentModelSelectionStore(),
      conversationId: 'main',
      context: () => ({}),
    });

    const older = controller.switchConversation('slow');
    await controller.switchConversation('fast');
    releaseSlow?.(emptySnapshot('slow'));
    await older;

    expect(controller.state().conversationId).toBe('fast');
    expect(controller.state().snapshot.conversationId).toBe('fast');
    await controller.close();
  });
});

test('submit keeps its conversation and model while a selection load is deferred', async () => {
  const fixture = fakeHarness();
  const store = createMemoryAgentModelSelectionStore();
  await store.save('one', { modelId: 'model-a', selectedAt: observedAt });
  await store.save('two', { modelId: 'model-b', selectedAt: observedAt });
  let defer = false;
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const selections = {
    ...store,
    async load(id: string) {
      const value = await store.load(id);
      if (defer && id === 'one') {
        started.resolve();
        await release.promise;
      }
      return value;
    },
  };
  const controller = await createAgentTuiController({
    harness: fixture.harness,
    catalog,
    selections,
    conversationId: 'one',
    context: () => ({}),
  });
  defer = true;
  const pending = controller.submit('belongs to one').catch((error) => error);
  await started.promise;
  await controller.switchConversation('two');
  release.resolve();
  expect(await pending).toBeInstanceOf(Error);
  expect(fixture.submissions[0]).toMatchObject({
    conversationId: 'one',
    metadata: { modelId: 'model-a' },
    parts: [{ type: 'text', text: 'belongs to one' }],
  });
  expect(controller.state().conversationId).toBe('two');
  await controller.close();
});

test('approval retains the original run model across a deferred context and conversation switch', async () => {
  const fixture = fakeHarness({
    snapshot: pinnedSnapshot('model-a'),
    approval: {
      conversationId: 'main',
      runId: 'run-1',
      messageId: 'assistant-1',
      approvalId: 'approval-1',
      callId: 'call-1',
      toolName: 'edit_file',
      input: {},
    },
  });
  const context = Promise.withResolvers<Record<string, never>>();
  const controller = await createAgentTuiController({
    harness: fixture.harness,
    catalog,
    selections: createMemoryAgentModelSelectionStore(),
    conversationId: 'main',
    context: () => context.promise,
  });
  const pending = controller.respondToApproval(true).catch((error) => error);
  await controller.switchConversation('other');
  await controller.selectModel('model-b');
  context.resolve({});
  expect(await pending).toBeInstanceOf(Error);
  expect(fixture.approvalDecisions[0]).toMatchObject({
    conversationId: 'main',
    approvalId: 'approval-1',
    metadata: { modelId: 'model-a' },
  });
  expect(controller.state().selectedModelId).toBe('model-b');
  await controller.close();
});

test('interrupt uses the visible snapshot while a conversation switch is pending', async () => {
  const slow = Promise.withResolvers<AgentSnapshot>();
  const interrupted: Array<{ conversationId: string; runId: string }> = [];
  const fixture = fakeHarness({
    snapshotFor: async (id) => (id === 'two' ? slow.promise : pinnedSnapshot('model-a')),
  });
  fixture.harness.interrupt = async (input) => {
    interrupted.push(input);
    return { outcome: 'applied', snapshot: pinnedSnapshot('model-a') };
  };
  const controller = await createAgentTuiController({
    harness: fixture.harness,
    catalog,
    selections: createMemoryAgentModelSelectionStore(),
    conversationId: 'main',
    context: () => ({}),
  });
  const pending = controller.switchConversation('two');
  const interrupt = controller.interrupt();
  try {
    expect(interrupted).toEqual([{ conversationId: 'main', runId: 'run-1' }]);
  } finally {
    slow.resolve(emptySnapshot('two'));
    await Promise.all([pending, interrupt]);
  }
  expect(controller.state().snapshot.conversationId).toBe('two');
  await expect(controller.interrupt()).rejects.toThrow('No active run');
  await controller.close();
});
