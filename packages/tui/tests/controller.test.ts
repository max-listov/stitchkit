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
