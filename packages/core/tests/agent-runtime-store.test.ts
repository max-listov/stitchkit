import { describe, expect, test } from 'bun:test';
import {
  AgentMessageSchema,
  AgentRunSchema,
  createMemoryAgentRuntimeStore,
} from '../src/agent-runtime';

const timestamp = '2026-08-22T00:00:00.000Z';

function inputMessage(id: string) {
  return AgentMessageSchema.parse({
    schemaVersion: 1,
    id,
    conversationId: 'conversation-1',
    role: 'user',
    status: 'committed',
    parts: [{ type: 'text', text: 'hello' }],
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

function queuedRun(
  inputId: string,
  runId = 'run-1',
  assistantMessageId = runId === 'run-1' ? 'assistant-1' : `assistant-${runId}`,
) {
  return AgentRunSchema.parse({
    schemaVersion: 1,
    id: runId,
    conversationId: 'conversation-1',
    inputMessageIds: [inputId],
    assistantMessageId,
    state: 'queued',
    revision: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

describe('AgentRuntimeStore reference adapter', () => {
  test('accepts input and queued run atomically and deduplicates the assignment', async () => {
    const store = createMemoryAgentRuntimeStore();
    const input = inputMessage('input-1');
    const run = queuedRun(input.id);

    const accepted = await store.acceptInputAndAssignRun({
      idempotencyKey: 'request-1',
      input,
      run,
    });
    expect(accepted.outcome).toBe('applied');

    const duplicate = await store.acceptInputAndAssignRun({
      idempotencyKey: 'request-1',
      input: inputMessage('different-input'),
      run: queuedRun('different-input'),
    });
    expect(duplicate.outcome).toBe('duplicate');
    if (duplicate.outcome === 'duplicate') expect(duplicate.runId).toBe('run-1');

    const snapshot = await store.loadSnapshot('conversation-1');
    expect(snapshot.messages).toHaveLength(1);
    expect(snapshot.runs).toHaveLength(1);
  });

  test('coalesces another durable input into the same queued successor run', async () => {
    const store = createMemoryAgentRuntimeStore();
    const first = inputMessage('input-1');
    await store.acceptInputAndAssignRun({
      idempotencyKey: 'request-1',
      input: first,
      run: queuedRun(first.id),
    });

    const second = inputMessage('input-2');
    const coalesced = await store.acceptInputAndAssignRun({
      idempotencyKey: 'request-2',
      input: second,
      run: queuedRun(second.id, 'run-1', 'assistant-1'),
      coalesceIntoRunId: 'run-1',
    });

    expect(coalesced.outcome).toBe('applied');
    const snapshot = await store.loadSnapshot('conversation-1');
    expect(snapshot.messages.map((message) => message.id)).toEqual(['input-1', 'input-2']);
    expect(snapshot.runs).toHaveLength(1);
    expect(snapshot.runs[0]?.inputMessageIds).toEqual(['input-1', 'input-2']);
    expect(snapshot.runs[0]?.revision).toBe(1);
  });

  test('rejects assistant identities that could overwrite canonical history', async () => {
    const store = createMemoryAgentRuntimeStore();
    const first = inputMessage('input-1');
    await store.acceptInputAndAssignRun({
      idempotencyKey: 'request-1',
      input: first,
      run: queuedRun(first.id),
    });

    const sameAsInput = inputMessage('input-2');
    await expect(
      store.acceptInputAndAssignRun({
        idempotencyKey: 'request-2',
        input: sameAsInput,
        run: queuedRun(sameAsInput.id, 'run-2', sameAsInput.id),
      }),
    ).rejects.toThrow('valid assignment');

    const existingMessage = inputMessage('input-3');
    await expect(
      store.acceptInputAndAssignRun({
        idempotencyKey: 'request-3',
        input: existingMessage,
        run: queuedRun(existingMessage.id, 'run-3', first.id),
      }),
    ).rejects.toThrow('valid assignment');

    const existingRunAssistant = inputMessage('input-4');
    await expect(
      store.acceptInputAndAssignRun({
        idempotencyKey: 'request-4',
        input: existingRunAssistant,
        run: queuedRun(existingRunAssistant.id, 'run-4', 'assistant-1'),
      }),
    ).rejects.toThrow('valid assignment');

    const snapshot = await store.loadSnapshot('conversation-1');
    expect(snapshot.messages.map((message) => message.id)).toEqual(['input-1']);
    expect(snapshot.runs.map((run) => run.id)).toEqual(['run-1']);
  });

  test('rejects a stale checkpoint and commits terminal state once', async () => {
    const store = createMemoryAgentRuntimeStore();
    const input = inputMessage('input-1');
    const run = queuedRun(input.id);
    await store.acceptInputAndAssignRun({ idempotencyKey: 'request-1', input, run });
    const acquired = await store.acquireRun({
      conversationId: 'conversation-1',
      runId: 'run-1',
      expectedRevision: 0,
      ownerId: 'runtime-1',
    });
    if (acquired.outcome !== 'applied') throw new Error('run was not acquired');
    const current = acquired.snapshot.runs[0];
    if (!current) throw new Error('run missing');
    const assistant = AgentMessageSchema.parse({
      schemaVersion: 1,
      id: 'assistant-1',
      conversationId: 'conversation-1',
      runId: 'run-1',
      role: 'assistant',
      status: 'completed',
      parts: [{ type: 'text', text: 'done' }],
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const staleFence = await store.commitRunTerminal({
      conversationId: 'conversation-1',
      runId: 'run-1',
      expectedRevision: current.revision,
      ownerId: 'runtime-1',
      fencingToken: (current.fencingToken ?? 0) + 1,
      assistant,
      reason: 'success',
    });
    expect(staleFence.outcome).toBe('conflict');
    const terminal = await store.commitRunTerminal({
      conversationId: 'conversation-1',
      runId: 'run-1',
      expectedRevision: current.revision,
      ownerId: 'runtime-1',
      fencingToken: current.fencingToken,
      assistant,
      reason: 'success',
    });
    expect(terminal.outcome).toBe('applied');
    const duplicateTerminal = await store.commitRunTerminal({
      conversationId: 'conversation-1',
      runId: 'run-1',
      expectedRevision: current.revision,
      ownerId: 'runtime-1',
      assistant,
      reason: 'success',
    });
    expect(duplicateTerminal.outcome).toBe('conflict');
  });

  test('requires replay evidence before requeueing an acquired run', async () => {
    const store = createMemoryAgentRuntimeStore();
    const input = inputMessage('input-1');
    const run = queuedRun(input.id);
    await store.acceptInputAndAssignRun({ idempotencyKey: 'request-1', input, run });
    const acquired = await store.acquireRun({
      conversationId: 'conversation-1',
      runId: 'run-1',
      expectedRevision: 0,
      ownerId: 'crashed-runtime',
    });
    if (acquired.outcome !== 'applied') throw new Error('run was not acquired');
    const current = acquired.snapshot.runs[0];
    if (!current) throw new Error('run missing');

    await expect(
      store.recoverRun({
        conversationId: 'conversation-1',
        runId: 'run-1',
        expectedRevision: current.revision,
        action: 'requeue',
      }),
    ).rejects.toThrow('replaySafe');

    const recovered = await store.recoverRun({
      conversationId: 'conversation-1',
      runId: 'run-1',
      expectedRevision: current.revision,
      action: 'requeue',
      replaySafe: true,
    });
    expect(recovered.outcome).toBe('applied');
    if (recovered.outcome === 'applied') {
      expect(recovered.snapshot.runs[0]?.state).toBe('queued');
      expect(recovered.snapshot.runs[0]?.ownerId).toBeUndefined();
    }
  });
});
