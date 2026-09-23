import {
  type AgentToolFenceConfig,
  createAgentToolFenceLifecycle,
} from 'stitchkit/agent-runtime';
import {
  type ApplicationHandle,
  createApplication,
  createBoundedAdmission,
  defineManagedResource,
} from 'stitchkit/application';
import {
  createAsyncOperationSnapshotSchema,
  defineAsyncOperation,
  defineAsyncOperationContract,
} from 'stitchkit/tools';
import { z } from 'zod';

export const DurableOperationRequestSchema = z.object({
  principalId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  requestHash: z.string().min(1),
  input: z.string(),
});
export const DurableOperationIdSchema = z.object({
  principalId: z.string().min(1),
  operationId: z.string().min(1),
});
export const DurableOperationRecordSchema = z.object({
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative(),
  operationId: z.string().min(1),
  principalId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  requestHash: z.string().min(1),
  input: z.string(),
  phase: z.enum(['pending', 'running', 'succeeded', 'failed', 'cancelled']),
  attemptId: z.string().min(1).optional(),
  fencingToken: z.number().int().nonnegative(),
  cancelRequested: z.boolean(),
  dispatchState: z.enum(['not-dispatched', 'possibly-dispatched', 'acknowledged']),
  effectKey: z.string().min(1).optional(),
  providerReceiptId: z.string().min(1).optional(),
  progress: z.number().min(0).max(1).optional(),
  result: z.string().optional(),
  artifacts: z.array(z.string().min(1)),
  failureCode: z.string().min(1).optional(),
});

export type DurableOperationRequest = z.output<typeof DurableOperationRequestSchema>;
export type DurableOperationId = z.output<typeof DurableOperationIdSchema>;
export type DurableOperationRecord = z.output<typeof DurableOperationRecordSchema>;

export type DurableOperationAdmission =
  | { outcome: 'created' | 'existing'; record: DurableOperationRecord }
  | { outcome: 'conflict'; record: DurableOperationRecord };

/** Application-owned persistence boundary. Implement admit and CAS transactionally. */
export interface DurableOperationStore {
  admit(request: DurableOperationRequest): Promise<DurableOperationAdmission>;
  read(id: DurableOperationId): Promise<DurableOperationRecord | undefined>;
  compareAndSwap(
    expectedRevision: number,
    next: DurableOperationRecord,
  ): Promise<DurableOperationRecord | undefined>;
  recoverable(): Promise<readonly DurableOperationRecord[]>;
}

export interface DurableOperationProvider {
  submit(input: {
    effectKey: string;
    operationId: string;
    payload: string;
    signal: AbortSignal;
    reportProgress(ratio: number): Promise<void>;
  }): Promise<{ receiptId: string; result?: string; artifacts?: readonly string[] }>;
  reconcile(input: {
    effectKey: string;
    operationId: string;
    signal: AbortSignal;
  }): Promise<
    | { outcome: 'pending' | 'unknown' }
    | { outcome: 'succeeded'; receiptId: string; result: string; artifacts: readonly string[] }
    | { outcome: 'failed'; receiptId: string; code: string }
  >;
}

const SnapshotSchema = createAsyncOperationSnapshotSchema({
  progress: z.object({ ratio: z.number().min(0).max(1) }),
  failure: z.object({ code: z.string() }),
});
const ResultSchema = z.object({ result: z.string() });
const ArtifactsSchema = z.object({ references: z.array(z.string()) });

export interface DurableAsyncOperationHarness {
  readonly application: ApplicationHandle;
  readonly contract: ReturnType<typeof defineAsyncOperationContract>;
  readonly operation: ReturnType<typeof createOperation>;
  createToolFence(
    config: AgentToolFenceConfig,
  ): ReturnType<typeof createAgentToolFenceLifecycle>;
  recover(): Promise<void>;
}

function nextRecord(
  record: DurableOperationRecord,
  patch: Partial<DurableOperationRecord>,
): DurableOperationRecord {
  return DurableOperationRecordSchema.parse({
    ...record,
    ...patch,
    revision: record.revision + 1,
  });
}

function createOperation(
  store: DurableOperationStore,
  start: (record: DurableOperationRecord) => void,
) {
  return defineAsyncOperation({
    mode: 'runtime-only',
    name: 'durable_operation',
    description: 'Run an application-owned durable operation',
    identity: { serviceName: 'durable-operations', action: 'operation', scope: 'user' },
    startInput: DurableOperationRequestSchema,
    id: DurableOperationIdSchema,
    state: DurableOperationRecordSchema,
    snapshot: SnapshotSchema,
    start: async (input) => {
      const admitted = await store.admit(input);
      if (admitted.outcome === 'conflict') {
        throw new Error('Idempotency key was reused with a different request hash');
      }
      if (admitted.outcome === 'created') start(admitted.record);
      return {
        principalId: admitted.record.principalId,
        operationId: admitted.record.operationId,
      };
    },
    authorize: async (id) => {
      const record = await store.read(id);
      if (!record || record.principalId !== id.principalId)
        throw new Error('Operation not found');
    },
    inspect: async (id) => {
      const record = await store.read(id);
      if (!record) throw new Error('Operation not found');
      return record;
    },
    classify: (record): z.output<typeof SnapshotSchema> => {
      const progress = record.progress === undefined ? undefined : { ratio: record.progress };
      if (record.phase === 'failed') {
        return {
          phase: 'failed',
          failure: { code: record.failureCode ?? 'FAILED' },
          progress,
        };
      }
      if (record.phase === 'cancelled') return { phase: 'cancelled', progress };
      if (record.phase === 'succeeded') return { phase: 'succeeded', progress };
      return { phase: record.phase, progress };
    },
    cancel: {
      handler: async (
        record: DurableOperationRecord,
      ): Promise<{ outcome: 'accepted' } | { outcome: 'already_terminal' }> => {
        if (['succeeded', 'failed', 'cancelled'].includes(record.phase)) {
          return { outcome: 'already_terminal' };
        }
        await store.compareAndSwap(
          record.revision,
          nextRecord(record, { cancelRequested: true }),
        );
        return { outcome: 'accepted' };
      },
    },
    result: {
      output: ResultSchema,
      handler: (record: DurableOperationRecord) => ({ result: record.result ?? '' }),
    },
    artifacts: {
      output: ArtifactsSchema,
      handler: (record: DurableOperationRecord) => ({ references: record.artifacts }),
    },
    backoff: [0],
  });
}

export function createDurableAsyncOperationHarness(config: {
  store: DurableOperationStore;
  provider: DurableOperationProvider;
  effectKey?: (record: DurableOperationRecord) => string;
  onWorkerError?: (error: unknown) => void | Promise<void>;
}): DurableAsyncOperationHarness {
  const workers = new Set<Promise<void>>();
  const admission = createBoundedAdmission({
    policy: { global: { maxConcurrent: 4 }, perKey: { maxConcurrent: 1, maxKeys: 1_000 } },
  });
  const abort = new AbortController();

  const commitTerminal = async (
    record: DurableOperationRecord,
    outcome:
      | { phase: 'succeeded'; receiptId: string; result: string; artifacts: readonly string[] }
      | { phase: 'failed'; receiptId: string; code: string },
  ): Promise<void> => {
    await config.store.compareAndSwap(
      record.revision,
      nextRecord(record, {
        phase: outcome.phase,
        dispatchState: 'acknowledged',
        providerReceiptId: outcome.receiptId,
        ...(outcome.phase === 'succeeded'
          ? { progress: 1, result: outcome.result, artifacts: [...outcome.artifacts] }
          : { failureCode: outcome.code }),
      }),
    );
  };

  const execute = async (initial: DurableOperationRecord): Promise<void> => {
    await admission.run(initial.principalId, async ({ signal }) => {
      const current = await config.store.read({
        principalId: initial.principalId,
        operationId: initial.operationId,
      });
      if (current?.phase !== 'pending') return;
      const effectKey = config.effectKey?.(current) ?? `${current.operationId}:1`;
      const prepared = await config.store.compareAndSwap(
        current.revision,
        nextRecord(current, {
          phase: 'running',
          attemptId: crypto.randomUUID(),
          fencingToken: current.fencingToken + 1,
          dispatchState: 'possibly-dispatched',
          effectKey,
        }),
      );
      if (!prepared) return;
      let active = prepared;
      const submitted = await config.provider.submit({
        effectKey,
        operationId: prepared.operationId,
        payload: prepared.input,
        signal,
        reportProgress: async (ratio) => {
          const currentRecord = await config.store.read({
            principalId: prepared.principalId,
            operationId: prepared.operationId,
          });
          if (currentRecord?.phase !== 'running') return;
          const progressed = await config.store.compareAndSwap(
            currentRecord.revision,
            nextRecord(currentRecord, { progress: ratio }),
          );
          if (progressed) active = progressed;
        },
      });
      const latest =
        (await config.store.read({
          principalId: active.principalId,
          operationId: active.operationId,
        })) ?? active;
      await commitTerminal(latest, {
        phase: 'succeeded',
        receiptId: submitted.receiptId,
        result: submitted.result ?? '',
        artifacts: submitted.artifacts ?? [],
      });
    });
  };

  const launch = (record: DurableOperationRecord): void => {
    const worker = execute(record)
      .catch((error: unknown) => config.onWorkerError?.(error))
      .then(() => undefined)
      .finally(() => workers.delete(worker));
    workers.add(worker);
  };

  const resource = defineManagedResource({
    id: 'durable-operation-workers',
    start(context) {
      context.reportHealth('healthy');
    },
    stopAdmission() {
      admission.stopAdmission();
    },
    async drain() {
      await Promise.all([...workers]);
      await admission.drain();
    },
    close() {
      abort.abort();
    },
    force() {
      abort.abort();
      admission.force();
    },
  });
  const application = createApplication({
    id: 'durable-operation-harness',
    resources: [resource],
  });
  const operation = createOperation(config.store, (record) => {
    const lease = application.admission.acquire();
    if (!lease) throw new Error('Application is not accepting operations');
    const worker = execute(record)
      .catch((error: unknown) => config.onWorkerError?.(error))
      .then(() => undefined)
      .finally(() => lease.release());
    workers.add(worker);
    void worker.finally(() => workers.delete(worker));
  });

  const recover = async (): Promise<void> => {
    for (const record of await config.store.recoverable()) {
      if (record.dispatchState === 'not-dispatched') {
        launch(record);
        continue;
      }
      if (!record.effectKey || record.dispatchState !== 'possibly-dispatched') continue;
      const outcome = await config.provider.reconcile({
        effectKey: record.effectKey,
        operationId: record.operationId,
        signal: abort.signal,
      });
      if (outcome.outcome === 'succeeded') {
        await commitTerminal(record, { phase: 'succeeded', ...outcome });
      } else if (outcome.outcome === 'failed') {
        await commitTerminal(record, {
          phase: 'failed',
          receiptId: outcome.receiptId,
          code: outcome.code,
        });
      }
    }
  };

  return {
    application,
    operation,
    recover,
    createToolFence: (fenceConfig) => createAgentToolFenceLifecycle(fenceConfig),
    contract: defineAsyncOperationContract({
      prefix: 'operations',
      scope: 'user',
      description: 'Application-owned durable operations',
      startInput: DurableOperationRequestSchema,
      id: DurableOperationIdSchema,
      snapshot: SnapshotSchema,
      cancel: true,
      result: ResultSchema,
      artifacts: ArtifactsSchema,
    }),
  };
}
