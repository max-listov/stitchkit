/**
 * Compile-time contract for contract-backed async-operation capability keys.
 * Checked by `bun run check`; Bun's runtime test discovery intentionally skips
 * files without the `.test.` segment.
 */
import { z } from 'zod';
import { defineContract } from '../src/contract';
import { bindContractAsyncOperation } from '../src/tools/async-operation';

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
bindContractAsyncOperation({
  mode: 'contract-backed',
  contract,
  capabilities: { start: 'start', status: 'status', wait: 'wait' },
  handlers,
});

bindContractAsyncOperation({
  mode: 'contract-backed',
  contract,
  capabilities: {
    start: 'start',
    // @ts-expect-error — follow-up input does not match the start output.
    status: 'wrongInput',
    // @ts-expect-error — an invalid status leaves no compatible wait key.
    wait: 'wait',
  },
  handlers,
});

bindContractAsyncOperation({
  mode: 'contract-backed',
  contract,
  capabilities: {
    start: 'start',
    status: 'status',
    // @ts-expect-error — wait output does not match the status snapshot.
    wait: 'wrongSnapshot',
  },
  handlers,
});
