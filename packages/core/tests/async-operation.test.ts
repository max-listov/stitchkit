import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { AppError, defineContract } from '../src/contract';
import { ManagedFileRefSchema } from '../src/contract/file-ref';
import {
  type AsyncOperationCancelResult,
  AsyncOperationCancelResultSchema,
  type AsyncOperationCapability,
  type AsyncOperationIdentity,
  bindContractAsyncOperation,
  createAsyncOperationSnapshotSchema,
  defineAsyncOperation,
} from '../src/tools/async-operation';
import type { RuntimeToolHandlerContext } from '../src/tools/runtime-tool';

const IdSchema = z.object({ id: z.string() });
const StateSchema = z.object({
  phase: z.enum(['queued', 'working', 'done', 'error', 'cancelled']),
  value: z.string().optional(),
  privateCause: z.string().optional(),
});
const SnapshotSchema = createAsyncOperationSnapshotSchema({
  progress: z.object({ current: z.number(), total: z.number() }),
  failure: z.object({ code: z.string() }),
});

function context(id: string, signal?: AbortSignal) {
  return { params: undefined, input: { id }, source: 'mcp', signal };
}

type TestId = z.output<typeof IdSchema>;
type TestState = z.output<typeof StateSchema>;
type TestSnapshot = z.output<typeof SnapshotSchema>;
type FollowCapability = Exclude<AsyncOperationCapability, 'start'>;
type FollowContext = RuntimeToolHandlerContext<typeof IdSchema>;

interface OperationFixtureConfig {
  name?: string;
  identity?: AsyncOperationIdentity;
  scopes?: Partial<Record<AsyncOperationCapability, string>>;
  authorize?: (
    id: TestId,
    capability: FollowCapability,
    context: FollowContext,
  ) => void | Promise<void>;
  inspect?: (id: TestId, context: FollowContext) => TestState | Promise<TestState>;
  classify?: (
    state: TestState,
    context: FollowContext,
  ) => TestSnapshot | Promise<TestSnapshot>;
  cancel?: (
    state: TestState,
    context: FollowContext,
  ) => AsyncOperationCancelResult | Promise<AsyncOperationCancelResult>;
}

function operationFixture(config: OperationFixtureConfig = {}) {
  const cancel: NonNullable<OperationFixtureConfig['cancel']> =
    config.cancel ?? (() => ({ outcome: 'accepted' }));
  return defineAsyncOperation({
    mode: 'runtime-only',
    name: config.name ?? 'job',
    description: 'Run job',
    identity: config.identity ?? { serviceName: 'jobs', action: 'job', scope: 'user' },
    startInput: z.object({}),
    id: IdSchema,
    state: StateSchema,
    snapshot: SnapshotSchema,
    start: () => ({ id: 'one' }),
    authorize: config.authorize ?? (() => undefined),
    inspect: config.inspect ?? ((): TestState => ({ phase: 'done', value: 'ready' })),
    classify:
      config.classify ??
      ((state): TestSnapshot => {
        if (state.phase === 'done') return { phase: 'succeeded' };
        if (state.phase === 'error') {
          return { phase: 'failed', failure: { code: 'JOB_FAILED' } };
        }
        if (state.phase === 'cancelled') return { phase: 'cancelled' };
        return { phase: state.phase === 'queued' ? 'pending' : 'running' };
      }),
    cancel: { handler: cancel },
    result: {
      output: z.object({ value: z.string() }),
      handler: (state: TestState) => ({ value: state.value ?? '' }),
    },
    artifacts: {
      output: ManagedFileRefSchema.array(),
      handler: () => [],
    },
    scopes: config.scopes,
    backoff: [0],
  });
}

describe('async operation protocol', () => {
  test('one runtime descriptor exports only configured capabilities', async () => {
    let state: z.output<typeof StateSchema> = { phase: 'done', value: 'ready' };
    let inspectCalls = 0;
    const authorizations: string[] = [];
    const operation = defineAsyncOperation({
      mode: 'runtime-only',
      name: 'export',
      description: 'Export a document',
      identity: { serviceName: 'exports', action: 'export', scope: 'user' },
      startInput: z.object({ format: z.enum(['csv', 'json']) }),
      id: IdSchema,
      state: StateSchema,
      snapshot: SnapshotSchema,
      start: () => ({ id: 'job-1' }),
      authorize: async (_id, capability) => {
        authorizations.push(capability);
      },
      inspect: () => {
        inspectCalls += 1;
        return state;
      },
      classify: (current): z.output<typeof SnapshotSchema> => {
        if (current.phase === 'done') return { phase: 'succeeded' };
        if (current.phase === 'error') {
          return { phase: 'failed', failure: { code: 'EXPORT_FAILED' } };
        }
        if (current.phase === 'cancelled') return { phase: 'cancelled' };
        return { phase: current.phase === 'queued' ? 'pending' : 'running' };
      },
      cancel: {
        handler: (): z.output<typeof AsyncOperationCancelResultSchema> => {
          state = { phase: 'cancelled' };
          return { outcome: 'accepted' };
        },
      },
      result: {
        output: z.object({ value: z.string() }),
        handler: (current: z.output<typeof StateSchema>) => ({ value: current.value ?? '' }),
      },
      artifacts: {
        output: ManagedFileRefSchema.array(),
        handler: () => [{ path: 'exports/job-1.csv', size: 12, mediaType: 'text/csv' }],
      },
      backoff: [0],
    });

    expect(operation.runtimeTools.map((tool) => tool.name)).toEqual([
      'export_start',
      'export_status',
      'export_wait',
      'export_cancel',
      'export_result',
      'export_artifacts',
    ]);
    expect(await operation.status.handler(context('job-1'))).toEqual({ phase: 'succeeded' });
    inspectCalls = 0;
    expect(await operation.result.handler(context('job-1'))).toEqual({ value: 'ready' });
    expect(inspectCalls).toBe(1);
    expect(await operation.artifacts.handler(context('job-1'))).toEqual([
      { path: 'exports/job-1.csv', size: 12, mediaType: 'text/csv' },
    ]);
    expect(
      AsyncOperationCancelResultSchema.parse(await operation.cancel.handler(context('job-1'))),
    ).toEqual({ outcome: 'accepted' });
    expect(authorizations).toEqual(['status', 'result', 'artifacts', 'cancel']);
  });

  test('unconfigured optional capabilities are absent at runtime and in the inferred keys', () => {
    const operation = defineAsyncOperation({
      mode: 'runtime-only',
      name: 'job',
      description: 'Run job',
      identity: { serviceName: 'jobs', action: 'job' },
      startInput: z.object({}),
      id: IdSchema,
      state: StateSchema,
      snapshot: SnapshotSchema,
      start: () => ({ id: 'one' }),
      authorize: () => undefined,
      inspect: (): z.output<typeof StateSchema> => ({ phase: 'queued' }),
      classify: (): z.output<typeof SnapshotSchema> => ({ phase: 'pending' }),
    });
    type HasCancel = 'cancel' extends keyof typeof operation ? true : false;
    type HasResult = 'result' extends keyof typeof operation ? true : false;
    const hasCancel: HasCancel = false;
    const hasResult: HasResult = false;
    expect(hasCancel).toBe(false);
    expect(hasResult).toBe(false);
    expect(operation.runtimeTools).toHaveLength(3);
    expect('cancel' in operation).toBe(false);
    expect(operation.runtimeTools.find((tool) => tool.name === 'job_cancel')).toBeUndefined();
  });

  test('result is gated by the already-inspected snapshot and does no second lookup', async () => {
    let calls = 0;
    const operation = defineAsyncOperation({
      mode: 'runtime-only',
      name: 'job',
      description: 'Run job',
      identity: { serviceName: 'jobs', action: 'job' },
      startInput: z.object({}),
      id: IdSchema,
      state: StateSchema,
      snapshot: SnapshotSchema,
      start: () => ({ id: 'one' }),
      authorize: () => undefined,
      inspect: (): z.output<typeof StateSchema> => {
        calls += 1;
        return { phase: 'working' };
      },
      classify: (): z.output<typeof SnapshotSchema> => ({ phase: 'running' }),
      result: {
        output: z.object({ value: z.string() }),
        handler: () => ({ value: 'unreachable' }),
      },
    });
    await expect(operation.result.handler(context('one'))).rejects.toMatchObject({
      code: 'OPERATION_NOT_SUCCEEDED',
    });
    expect(calls).toBe(1);
  });

  test('wait abort never invokes the application cancel capability', async () => {
    let cancels = 0;
    const operation = defineAsyncOperation({
      mode: 'runtime-only',
      name: 'job',
      description: 'Run job',
      identity: { serviceName: 'jobs', action: 'job' },
      startInput: z.object({}),
      id: IdSchema,
      state: StateSchema,
      snapshot: SnapshotSchema,
      start: () => ({ id: 'one' }),
      authorize: () => undefined,
      inspect: async (_id, currentContext): Promise<z.output<typeof StateSchema>> => {
        await new Promise<void>((_resolve, reject) => {
          currentContext.signal?.addEventListener(
            'abort',
            () => reject(currentContext.signal?.reason),
            { once: true },
          );
        });
        return { phase: 'working' };
      },
      classify: (): z.output<typeof SnapshotSchema> => ({ phase: 'running' }),
      cancel: {
        handler: (): z.output<typeof AsyncOperationCancelResultSchema> => {
          cancels += 1;
          return { outcome: 'accepted' };
        },
      },
      defaultTimeout: 30,
    });
    const controller = new AbortController();
    const waiting = operation.wait.handler(context('one', controller.signal));
    await Promise.resolve();
    controller.abort(new Error('stop waiting'));
    await expect(waiting).rejects.toThrow('stop waiting');
    expect(cancels).toBe(0);
  });

  test('contract-backed binding reuses literal contract schemas and creates no router', () => {
    const ContractSnapshotSchema = z.object({ phase: z.enum(['pending', 'succeeded']) });
    const contract = defineContract(
      { prefix: 'exports' },
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
          input: IdSchema,
          output: ContractSnapshotSchema,
        },
        wait: {
          method: 'POST',
          path: '/wait',
          desc: 'Wait',
          input: IdSchema,
          output: ContractSnapshotSchema,
        },
      },
    );
    const bound = bindContractAsyncOperation({
      mode: 'contract-backed',
      contract,
      capabilities: { start: 'start', status: 'status', wait: 'wait' },
      handlers: {
        start: () => ({ id: 'one' }),
        status: (): z.output<typeof ContractSnapshotSchema> => ({ phase: 'pending' }),
        wait: (): z.output<typeof ContractSnapshotSchema> => ({ phase: 'succeeded' }),
      },
    });
    expect(bound.schemas.id).toBe(IdSchema);
    expect(bound.schemas.snapshot).toBe(ContractSnapshotSchema);
    expect('runtimeTools' in bound).toBe(false);
  });

  test('contract-backed runtime defence names the capability and shared schema requirement', () => {
    const StartIdSchema = z.object({ id: z.string() });
    const FollowIdSchema = z.object({ id: z.string() });
    const ContractSnapshotSchema = z.object({ phase: z.literal('succeeded') });
    const contract = defineContract(
      { prefix: 'exports' },
      {
        start: {
          method: 'POST',
          path: '/',
          desc: 'Start',
          output: StartIdSchema,
        },
        status: {
          method: 'POST',
          path: '/status',
          desc: 'Status',
          input: FollowIdSchema,
          output: ContractSnapshotSchema,
        },
        wait: {
          method: 'POST',
          path: '/wait',
          desc: 'Wait',
          input: FollowIdSchema,
          output: ContractSnapshotSchema,
        },
      },
    );

    expect(() =>
      bindContractAsyncOperation({
        mode: 'contract-backed',
        contract,
        capabilities: { start: 'start', status: 'status', wait: 'wait' },
        handlers: {
          start: () => ({ id: 'one' }),
          status: (): z.output<typeof ContractSnapshotSchema> => ({ phase: 'succeeded' }),
          wait: (): z.output<typeof ContractSnapshotSchema> => ({ phase: 'succeeded' }),
        },
      }),
    ).toThrow(
      'capability "status" input must reuse the same schema instance as the start output',
    );
  });

  test('every capability uses its suffixed action and configured scope override', () => {
    const scopes: Record<string, string> = {
      start: 'start-scope',
      status: 'status-scope',
      wait: 'wait-scope',
      cancel: 'cancel-scope',
      result: 'result-scope',
      artifacts: 'artifacts-scope',
    };
    const operation = operationFixture({ scopes });

    for (const tool of operation.runtimeTools) {
      const capability = tool.name.replace('job_', '');
      expect(tool.identity.action).toBe(`job.${capability}`);
      expect(tool.identity.scope).toBe(scopes[capability]);
    }
  });

  test('every capability inherits the base scope when no override is configured', () => {
    const operation = operationFixture({
      identity: { serviceName: 'jobs', action: 'export', scope: 'member' },
    });

    for (const tool of operation.runtimeTools) {
      const capability = tool.name.replace('job_', '');
      expect(tool.identity.action).toBe(`export.${capability}`);
      expect(tool.identity.scope).toBe('member');
    }
  });

  test('accepted already_terminal and rejected cancel outcomes reach the caller', async () => {
    const outcomes: AsyncOperationCancelResult[] = [
      { outcome: 'accepted' },
      { outcome: 'already_terminal' },
      { outcome: 'rejected', reason: 'not cancellable' },
    ];

    for (const outcome of outcomes) {
      const operation = operationFixture({ cancel: () => outcome });
      const received = await operation.cancel.handler(context('one'));
      expect(AsyncOperationCancelResultSchema.parse(received)).toEqual(outcome);
    }
  });

  test('a terminal cancel race is reported as already_terminal after one inspect', async () => {
    let inspections = 0;
    const operation = operationFixture({
      inspect: (): TestState => {
        inspections += 1;
        return { phase: 'done' };
      },
      cancel: (state) =>
        state.phase === 'done' ? { outcome: 'already_terminal' } : { outcome: 'accepted' },
    });

    expect(await operation.cancel.handler(context('one'))).toEqual({
      outcome: 'already_terminal',
    });
    expect(inspections).toBe(1);
  });

  test('definition name collisions fail across mandatory and optional capabilities', () => {
    expect(() =>
      defineAsyncOperation({
        mode: 'runtime-only',
        name: 'job',
        description: 'Run job',
        identity: { serviceName: 'jobs', action: 'job' },
        startInput: z.object({}),
        id: IdSchema,
        state: StateSchema,
        snapshot: SnapshotSchema,
        start: () => ({ id: 'one' }),
        authorize: () => undefined,
        inspect: (): TestState => ({ phase: 'queued' }),
        classify: (): TestSnapshot => ({ phase: 'pending' }),
        names: { status: 'job_wait' },
      }),
    ).toThrow('job_wait');
  });

  test('authorization denial hides existence and stops before inspect', async () => {
    let inspections = 0;
    const operation = operationFixture({
      authorize: () => {
        throw new AppError('OPERATION_NOT_FOUND', 'Operation not found', 404);
      },
      inspect: (): TestState => {
        inspections += 1;
        return { phase: 'done' };
      },
    });

    for (const id of ['foreign', 'missing']) {
      await expect(operation.status.handler(context(id))).rejects.toMatchObject({
        code: 'OPERATION_NOT_FOUND',
        message: 'Operation not found',
      });
    }
    expect(inspections).toBe(0);
  });

  test('snapshot regression is validated but not rejected as a transition', async () => {
    const states: TestState[] = [{ phase: 'done' }, { phase: 'working' }];
    const operation = operationFixture({
      inspect: (): TestState => states.shift() ?? { phase: 'working' },
    });

    expect(await operation.status.handler(context('one'))).toEqual({ phase: 'succeeded' });
    expect(await operation.status.handler(context('one'))).toEqual({ phase: 'running' });
  });

  test('failed snapshot strips the internal cause at the public schema boundary', async () => {
    const operation = operationFixture({
      inspect: (): TestState => ({
        phase: 'error',
        privateCause: 'provider credentials and raw response',
      }),
      classify: (state) => ({
        phase: 'failed',
        failure: { code: 'JOB_FAILED', privateCause: state.privateCause },
      }),
    });

    expect(await operation.status.handler(context('one'))).toEqual({
      phase: 'failed',
      failure: { code: 'JOB_FAILED' },
    });
  });

  test('wait accepts pending running succeeded snapshots from one application state source', async () => {
    const states: TestState[] = [{ phase: 'queued' }, { phase: 'working' }, { phase: 'done' }];
    const operation = operationFixture({
      inspect: (): TestState => states.shift() ?? { phase: 'done' },
    });

    expect(await operation.wait.handler(context('one'))).toEqual({ phase: 'succeeded' });
    expect(states).toEqual([]);
  });

  test('repeated application ids are accepted without framework uniqueness state', async () => {
    const operation = operationFixture();

    expect(
      await operation.start.handler({
        params: undefined,
        input: {},
        source: 'mcp',
      }),
    ).toEqual({ id: 'one' });
    expect(
      await operation.start.handler({
        params: undefined,
        input: {},
        source: 'mcp',
      }),
    ).toEqual({ id: 'one' });
  });
});
