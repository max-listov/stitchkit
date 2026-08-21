/**
 * Compile-time contract for contract-backed async-operation capability keys.
 * Checked by `bun run check`; Bun's runtime test discovery intentionally skips
 * files without the `.test.` segment.
 */
import { z } from 'zod';
import { defineContract } from '../src/contract';
import { createScopedImplement } from '../src/server/implement';
import {
  type AdaptedContractAsyncOperationConfig,
  bindContractAsyncOperation,
  defineAsyncOperationContract,
} from '../src/tools/async-operation';

const IdSchema = z.object({ id: z.string() });
const EquivalentIdSchema = z.object({ id: z.string() });
const WrongIdSchema = z.object({ slug: z.string() });
const SnapshotSchema = z.object({ phase: z.enum(['pending', 'succeeded']) });
const EquivalentSnapshotSchema = z.object({ phase: z.enum(['pending', 'succeeded']) });
const WrongSnapshotSchema = z.object({ done: z.boolean() });

const contract = defineContract(
  { prefix: 'jobs' },
  {
    start: {
      method: 'POST',
      path: '/',
      desc: 'Start',
      input: z.object({}),
      output: IdSchema,
    },
    status: {
      method: 'POST',
      path: '/status',
      desc: 'Status',
      input: EquivalentIdSchema,
      output: SnapshotSchema,
    },
    wait: {
      method: 'POST',
      path: '/wait',
      desc: 'Wait',
      input: IdSchema,
      output: EquivalentSnapshotSchema,
    },
    wrongInput: {
      method: 'POST',
      path: '/wrong-input',
      desc: 'Wrong input',
      input: WrongIdSchema,
      output: SnapshotSchema,
    },
    wrongSnapshot: {
      method: 'POST',
      path: '/wrong-snapshot',
      desc: 'Wrong snapshot',
      input: IdSchema,
      output: WrongSnapshotSchema,
    },
  },
);

const handlers = {
  start: () => ({ id: 'one' }),
  status: (): z.output<typeof SnapshotSchema> => ({ phase: 'pending' }),
  wait: (): z.output<typeof SnapshotSchema> => ({ phase: 'succeeded' }),
  wrongInput: (): z.output<typeof SnapshotSchema> => ({ phase: 'pending' }),
  wrongSnapshot: () => ({ done: false }),
};

// Structurally equivalent schema instances are accepted by the type-level
// binding; runtime identity remains a separate defence for untyped callers.
const direct = bindContractAsyncOperation({
  mode: 'contract-backed',
  contract,
  capabilities: { start: 'start', status: 'status', wait: 'wait' },
  handlers,
});
const directStatusInput = direct.adapters.inputFor.status({ id: 'one' });
const directWaitInput = direct.adapters.inputFor.wait({ id: 'one' });
void directStatusInput;
void directWaitInput;

// @ts-expect-error — status input does not match the start output.
bindContractAsyncOperation({
  mode: 'contract-backed',
  contract,
  capabilities: {
    start: 'start',
    // The incompatible status makes the wait mapping impossible below.
    status: 'wrongInput',
    wait: 'wait',
  },
  handlers,
});

const StartSnapshotSchema = z.object({ operation: IdSchema });
const StatusInputSchema = z.object({ operationId: z.string() });
const WaitInputSchema = z.object({ lookup: IdSchema });
const adaptedContract = defineContract(
  { prefix: 'adapted-jobs' },
  {
    start: {
      method: 'POST',
      path: '/',
      desc: 'Start',
      output: StartSnapshotSchema,
    },
    status: {
      method: 'POST',
      path: '/status',
      desc: 'Status',
      input: StatusInputSchema,
      output: SnapshotSchema,
    },
    wait: {
      method: 'POST',
      path: '/wait',
      desc: 'Wait',
      input: WaitInputSchema,
      output: SnapshotSchema,
    },
  },
);
const adaptedHandlers = {
  start: () => ({ operation: { id: 'one' } }),
  status: (): z.output<typeof SnapshotSchema> => ({ phase: 'pending' }),
  wait: (): z.output<typeof SnapshotSchema> => ({ phase: 'succeeded' }),
};
const inferredAdapted = bindContractAsyncOperation({
  mode: 'contract-backed',
  binding: 'adapted',
  contract: adaptedContract,
  id: IdSchema,
  capabilities: { start: 'start', status: 'status', wait: 'wait' },
  adapters: {
    idFromStart: (output) => output.operation,
    inputFor: {
      status: (id) => ({ operationId: id.id }),
      wait: (id) => ({ lookup: id }),
    },
  },
  handlers: adaptedHandlers,
});
const inferredStatus: z.output<typeof StatusInputSchema> =
  inferredAdapted.adapters.inputFor.status({ id: 'one' });
void inferredStatus;

const adaptedConfig: AdaptedContractAsyncOperationConfig<
  typeof adaptedContract.endpoints,
  'public',
  typeof IdSchema,
  'start',
  'status',
  'wait'
> = {
  mode: 'contract-backed',
  binding: 'adapted',
  contract: adaptedContract,
  id: IdSchema,
  capabilities: { start: 'start', status: 'status', wait: 'wait' },
  adapters: {
    idFromStart: (output) => output.operation,
    inputFor: {
      status: (id) => ({ operationId: id.id }),
      wait: (id) => ({ lookup: id }),
    },
  },
  handlers: adaptedHandlers,
};
const adapted = bindContractAsyncOperation(adaptedConfig);

const parsedId: z.output<typeof IdSchema> = adapted.adapters.idFromStart({
  operation: { id: 'one' },
});
const parsedStatusInput: z.output<typeof StatusInputSchema> =
  adapted.adapters.inputFor.status(parsedId);
void parsedStatusInput;

const invalidIdAdapterConfig: AdaptedContractAsyncOperationConfig<
  typeof adaptedContract.endpoints,
  'public',
  typeof IdSchema,
  'start',
  'status',
  'wait'
> = {
  mode: 'contract-backed',
  binding: 'adapted',
  contract: adaptedContract,
  id: IdSchema,
  capabilities: { start: 'start', status: 'status', wait: 'wait' },
  adapters: {
    // @ts-expect-error — idFromStart must return the declared operation-id input.
    idFromStart: () => ({ slug: 'one' }),
    inputFor: {
      status: (id) => ({ operationId: id.id }),
      wait: (id) => ({ lookup: id }),
    },
  },
  handlers: adaptedHandlers,
};
void invalidIdAdapterConfig;

const invalidStatusAdapterConfig: AdaptedContractAsyncOperationConfig<
  typeof adaptedContract.endpoints,
  'public',
  typeof IdSchema,
  'start',
  'status',
  'wait'
> = {
  mode: 'contract-backed',
  binding: 'adapted',
  contract: adaptedContract,
  id: IdSchema,
  capabilities: { start: 'start', status: 'status', wait: 'wait' },
  adapters: {
    idFromStart: (output) => output.operation,
    inputFor: {
      // @ts-expect-error — status adapter must return status endpoint input.
      status: () => ({ slug: 'one' }),
      wait: (id) => ({ lookup: id }),
    },
  },
  handlers: adaptedHandlers,
};
void invalidStatusAdapterConfig;

const canonical = defineAsyncOperationContract({
  prefix: 'jobs',
  description: 'Run job',
  startInput: z.object({}),
  id: IdSchema,
  snapshot: SnapshotSchema,
});
type CanonicalHasCancel = 'cancel' extends keyof typeof canonical.capabilities ? true : false;
const canonicalHasCancel: CanonicalHasCancel = false;
void canonicalHasCancel;

const scopedCanonical = defineAsyncOperationContract({
  prefix: 'member-jobs',
  scope: 'member',
  description: 'Run member job',
  startInput: z.object({}),
  id: IdSchema,
  snapshot: SnapshotSchema,
});
const canonicalScope: 'member' | undefined = scopedCanonical.contract.meta.scope;
void canonicalScope;

const scopedCapabilities = defineAsyncOperationContract({
  prefix: 'scoped-jobs',
  scope: 'member',
  description: 'Run scoped job',
  startInput: z.object({}),
  id: IdSchema,
  snapshot: SnapshotSchema,
  cancel: true,
  scopes: { cancel: 'admin' },
});
const cancelScope: 'admin' = scopedCapabilities.contract.endpoints.cancel.scope;
void cancelScope;
const implementScopedOperation = createScopedImplement<{
  member: { memberId: string };
  admin: { adminId: string };
}>();
implementScopedOperation(scopedCapabilities.contract, {
  start: (context) => ({ id: context.memberId }),
  status: (context) => ({ phase: context.memberId ? 'pending' : 'succeeded' }),
  wait: (context) => ({ phase: context.memberId ? 'succeeded' : 'pending' }),
  cancel: (context) => ({ outcome: context.adminId ? 'accepted' : 'already_terminal' }),
});

const TransformedIdSchema = z.object({ id: z.string().transform(Number) });
defineAsyncOperationContract({
  prefix: 'transformed-jobs',
  description: 'Run transformed job',
  startInput: z.object({}),
  // @ts-expect-error — canonical shorthand cannot invert a transformed parsed ID into wire input.
  id: TransformedIdSchema,
  snapshot: SnapshotSchema,
});

defineAsyncOperationContract({
  prefix: 'jobs',
  description: 'Run job',
  startInput: z.object({}),
  startOutput: StartSnapshotSchema,
  id: IdSchema,
  // @ts-expect-error — start-output extraction must return the declared id input.
  idFromStart: () => ({ slug: 'one' }),
  snapshot: SnapshotSchema,
});

// @ts-expect-error — wait output does not match the status snapshot.
bindContractAsyncOperation({
  mode: 'contract-backed',
  contract,
  capabilities: {
    start: 'start',
    status: 'status',
    wait: 'wrongSnapshot',
  },
  handlers,
});

// @ts-expect-error — adapted wait output must match the selected status snapshot.
bindContractAsyncOperation({
  mode: 'contract-backed',
  binding: 'adapted',
  contract,
  id: IdSchema,
  capabilities: { start: 'start', status: 'status', wait: 'wrongSnapshot' },
  adapters: {
    idFromStart: (output: z.output<typeof IdSchema>) => output,
    inputFor: {
      status: (id: z.output<typeof IdSchema>) => id,
      wait: (id: z.output<typeof IdSchema>) => id,
    },
  },
  handlers,
});
