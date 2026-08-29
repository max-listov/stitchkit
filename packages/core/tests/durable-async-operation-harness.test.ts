import { describe, expect, test } from 'bun:test';
import {
  createDurableAsyncOperationHarness,
  type DurableOperationAdmission,
  type DurableOperationId,
  type DurableOperationProvider,
  type DurableOperationRecord,
  DurableOperationRecordSchema,
  type DurableOperationRequest,
  type DurableOperationStore,
} from '../examples/durable-async-operation-harness';

class MemoryOperationStore implements DurableOperationStore {
  private readonly records = new Map<string, DurableOperationRecord>();
  private readonly keys = new Map<string, string>();
  private readonly terminalWaiters = new Map<string, () => void>();

  async admit(request: DurableOperationRequest): Promise<DurableOperationAdmission> {
    const key = `${request.principalId}:${request.idempotencyKey}`;
    const existingId = this.keys.get(key);
    const existing = existingId ? this.records.get(existingId) : undefined;
    if (existing) {
      return {
        outcome: existing.requestHash === request.requestHash ? 'existing' : 'conflict',
        record: existing,
      };
    }
    const operationId = `operation-${this.records.size + 1}`;
    const record = DurableOperationRecordSchema.parse({
      schemaVersion: 1,
      revision: 0,
      operationId,
      ...request,
      phase: 'pending',
      fencingToken: 0,
      cancelRequested: false,
      dispatchState: 'not-dispatched',
      artifacts: [],
    });
    this.records.set(operationId, record);
    this.keys.set(key, operationId);
    return { outcome: 'created', record };
  }

  async read(id: DurableOperationId): Promise<DurableOperationRecord | undefined> {
    const record = this.records.get(id.operationId);
    return record?.principalId === id.principalId ? record : undefined;
  }

  async compareAndSwap(
    expectedRevision: number,
    next: DurableOperationRecord,
  ): Promise<DurableOperationRecord | undefined> {
    const current = this.records.get(next.operationId);
    if (!current || current.revision !== expectedRevision) return undefined;
    const parsed = DurableOperationRecordSchema.parse(next);
    this.records.set(next.operationId, parsed);
    if (['succeeded', 'failed', 'cancelled'].includes(parsed.phase)) {
      this.terminalWaiters.get(parsed.operationId)?.();
      this.terminalWaiters.delete(parsed.operationId);
    }
    return parsed;
  }

  async recoverable(): Promise<readonly DurableOperationRecord[]> {
    return [...this.records.values()].filter((record) =>
      ['pending', 'running'].includes(record.phase),
    );
  }

  async waitForTerminal(operationId: string): Promise<DurableOperationRecord> {
    const current = this.records.get(operationId);
    if (current && ['succeeded', 'failed', 'cancelled'].includes(current.phase))
      return current;
    await new Promise<void>((resolve) => this.terminalWaiters.set(operationId, resolve));
    const terminal = this.records.get(operationId);
    if (!terminal) throw new Error('Operation disappeared');
    return terminal;
  }
}

function toolContext(input: DurableOperationRequest) {
  return { params: undefined, input, source: 'agent' };
}

describe('durable async operation composition', () => {
  test('duplicate starts share one operation while a changed request hash conflicts', async () => {
    const store = new MemoryOperationStore();
    let submissions = 0;
    const provider: DurableOperationProvider = {
      async submit() {
        submissions += 1;
        return { receiptId: 'receipt-1', result: 'ready', artifacts: ['artifact-1'] };
      },
      async reconcile() {
        return { outcome: 'unknown' };
      },
    };
    const harness = createDurableAsyncOperationHarness({ store, provider });
    await harness.application.start();
    const fence = harness.createToolFence({
      runId: 'run-1',
      assertCurrent: ({ runId }) => (runId === 'run-1' ? undefined : 'stale_run'),
    });
    if (!fence.beforeHandle) throw new Error('Tool fence has no beforeHandle phase');
    await fence.beforeHandle(
      { params: undefined, input: {}, source: 'agent' },
      {
        serviceName: 'durable-operations',
        key: 'start',
        method: 'POST',
        desc: 'Start durable operation',
      },
    );
    const request = {
      principalId: 'principal-1',
      idempotencyKey: 'request-1',
      requestHash: 'hash-1',
      input: 'payload',
    };

    const first = await harness.operation.start.handler(toolContext(request));
    const duplicate = await harness.operation.start.handler(toolContext(request));
    expect(duplicate).toEqual(first);
    await expect(
      harness.operation.start.handler(
        toolContext({ ...request, requestHash: 'different-hash' }),
      ),
    ).rejects.toThrow('different request hash');

    const terminal = await store.waitForTerminal(first.operationId);
    expect(terminal).toMatchObject({
      phase: 'succeeded',
      dispatchState: 'acknowledged',
      providerReceiptId: 'receipt-1',
      result: 'ready',
      artifacts: ['artifact-1'],
    });
    expect(submissions).toBe(1);
    await harness.application.shutdown();
  });

  test('ambiguous dispatch is reconciled after restart and is never blindly resubmitted', async () => {
    const store = new MemoryOperationStore();
    let submissions = 0;
    let reconciliations = 0;
    const errors: unknown[] = [];
    const provider: DurableOperationProvider = {
      async submit() {
        submissions += 1;
        throw new Error('connection ended after dispatch');
      },
      async reconcile() {
        reconciliations += 1;
        return {
          outcome: 'succeeded',
          receiptId: 'receipt-reconciled',
          result: 'recovered',
          artifacts: [],
        };
      },
    };
    const first = createDurableAsyncOperationHarness({
      store,
      provider,
      onWorkerError: (error) => {
        errors.push(error);
      },
    });
    await first.application.start();
    const id = await first.operation.start.handler(
      toolContext({
        principalId: 'principal-1',
        idempotencyKey: 'ambiguous-1',
        requestHash: 'hash-1',
        input: 'payload',
      }),
    );
    while (errors.length === 0) await Promise.resolve();
    await first.application.shutdown();

    const restarted = createDurableAsyncOperationHarness({ store, provider });
    await restarted.application.start();
    await restarted.recover();
    const terminal = await store.waitForTerminal(id.operationId);
    expect(terminal).toMatchObject({
      phase: 'succeeded',
      dispatchState: 'acknowledged',
      providerReceiptId: 'receipt-reconciled',
    });
    expect({ submissions, reconciliations }).toEqual({ submissions: 1, reconciliations: 1 });
    await restarted.application.shutdown();
  });

  test('progress and cancellation intent are durable while a provider attempt is active', async () => {
    const store = new MemoryOperationStore();
    let releaseProvider: (() => void) | undefined;
    let progressStored: (() => void) | undefined;
    const provider: DurableOperationProvider = {
      async submit(input) {
        await input.reportProgress(0.4);
        progressStored?.();
        await new Promise<void>((resolve) => {
          releaseProvider = resolve;
        });
        return { receiptId: 'receipt-1', result: 'ready' };
      },
      async reconcile() {
        return { outcome: 'unknown' };
      },
    };
    const harness = createDurableAsyncOperationHarness({ store, provider });
    await harness.application.start();
    const progressReady = new Promise<void>((resolve) => {
      progressStored = resolve;
    });
    const id = await harness.operation.start.handler(
      toolContext({
        principalId: 'principal-1',
        idempotencyKey: 'progress-1',
        requestHash: 'hash-1',
        input: 'payload',
      }),
    );
    await progressReady;
    const followContext = { params: undefined, input: id, source: 'agent' };
    expect(await harness.operation.status.handler(followContext)).toEqual({
      phase: 'running',
      progress: { ratio: 0.4 },
    });
    expect(await harness.operation.cancel.handler(followContext)).toEqual({
      outcome: 'accepted',
    });
    expect(await store.read(id)).toMatchObject({ cancelRequested: true, progress: 0.4 });
    releaseProvider?.();
    await store.waitForTerminal(id.operationId);
    await harness.application.shutdown();
  });
});
