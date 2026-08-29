import { createAgentToolFenceLifecycle } from 'stitchkit/agent-runtime';
import {
  createApplication,
  createBoundedAdmission,
  createBoundedChannel,
  defineManagedResource,
} from 'stitchkit/application';
import {
  createAsyncOperationSnapshotSchema,
  defineAsyncOperation,
  defineAsyncOperationContract,
} from 'stitchkit/tools';
import { z } from 'zod';

const id = z.object({ id: z.string() });
const state = z.object({ phase: z.literal('succeeded'), value: z.string() });
const snapshot = createAsyncOperationSnapshotSchema({
  failure: z.object({ code: z.string() }),
});
const operation = defineAsyncOperation({
  mode: 'runtime-only',
  name: 'packed_operation',
  description: 'Packed durable operation composition',
  identity: { serviceName: 'packed', action: 'operation' },
  startInput: z.object({ idempotencyKey: z.string() }),
  id,
  state,
  snapshot,
  start: ({ idempotencyKey }) => ({ id: idempotencyKey }),
  authorize: () => undefined,
  inspect: ({ id: operationId }) => ({ phase: 'succeeded', value: operationId }),
  classify: () => ({ phase: 'succeeded' }),
});
const contract = defineAsyncOperationContract({
  prefix: 'packed-operations',
  description: 'Packed durable operation contract',
  startInput: z.object({ idempotencyKey: z.string() }),
  id,
  snapshot,
});
const admission = createBoundedAdmission({ policy: { global: { maxConcurrent: 1 } } });
const outboxWakeup = createBoundedChannel({
  policy: 'ordered',
  maxItems: 1,
  maxBytes: 32,
  sizeOf: (value) => value.length,
});
const resource = defineManagedResource({
  id: 'packed-composition',
  start(context) {
    context.reportHealth('healthy');
  },
  stopAdmission() {
    admission.stopAdmission();
  },
  async drain() {
    await admission.drain();
  },
  close() {
    outboxWakeup.close({ mode: 'discard' });
  },
});
const app = createApplication({ id: 'packed-durable-composition', resources: [resource] });
const fence = createAgentToolFenceLifecycle({
  runId: 'run-1',
  assertCurrent: () => undefined,
});
await app.start();
const started = await operation.start.handler({
  params: undefined,
  input: { idempotencyKey: 'request-1' },
  source: 'agent',
});
if (started.id !== 'request-1' || contract.capabilities.start !== 'start') {
  throw new Error('Packed async-operation composition failed');
}
outboxWakeup.offer('delivery-1');
if (typeof fence.beforeHandle !== 'function')
  throw new Error('Packed fence composition failed');
await app.shutdown();
console.log('packed durable compositions: ok');
