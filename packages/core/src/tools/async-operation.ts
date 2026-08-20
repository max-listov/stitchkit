import { type ZodObject, type ZodType, z } from 'zod';
import type {
  ContractDef,
  EndpointDef,
  EndpointToolAnnotations,
  HttpMethod,
} from '../contract';
import { AppError } from '../contract';
import type { Handlers } from '../server/types';
import { defineWaitTool } from './define-wait-tool';
import { assertUniqueToolName } from './names';
import {
  defineRuntimeTool,
  type RuntimeToolDefinition,
  type RuntimeToolDefinitionWithOutput,
  type RuntimeToolHandlerContext,
  type RuntimeToolIdentity,
  type RuntimeToolTransport,
} from './runtime-tool';

export const AsyncOperationCancelResultSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('accepted') }),
  z.object({ outcome: z.literal('already_terminal') }),
  z.object({ outcome: z.literal('rejected'), reason: z.string().min(1) }),
]);

export type AsyncOperationCancelResult = z.infer<typeof AsyncOperationCancelResultSchema>;
export type AsyncOperationCapability =
  | 'start'
  | 'status'
  | 'wait'
  | 'cancel'
  | 'result'
  | 'artifacts';

export function createAsyncOperationSnapshotSchema<
  TProgress extends ZodType | undefined = undefined,
  TFailure extends ZodType = ZodType,
>(config: { progress?: TProgress; failure: TFailure }) {
  const progress = config.progress ? { progress: config.progress.optional() } : {};
  return z.discriminatedUnion('phase', [
    z.object({ phase: z.literal('pending'), ...progress }),
    z.object({ phase: z.literal('running'), ...progress }),
    z.object({ phase: z.literal('succeeded'), ...progress }),
    z.object({ phase: z.literal('failed'), failure: config.failure, ...progress }),
    z.object({ phase: z.literal('cancelled'), ...progress }),
  ]);
}

export interface AsyncOperationIdentity {
  serviceName: string;
  action: string;
  scope?: string;
  meta?: Record<string, unknown>;
}

export interface AsyncOperationCancelCapability<
  TId extends ZodObject,
  TState extends ZodType,
> {
  handler: (
    state: z.output<TState>,
    context: RuntimeToolHandlerContext<TId>,
  ) =>
    | z.output<typeof AsyncOperationCancelResultSchema>
    | Promise<z.output<typeof AsyncOperationCancelResultSchema>>;
}

export interface AsyncOperationOutputCapability<
  TId extends ZodObject,
  TState extends ZodType,
  TOutput extends ZodType,
> {
  output: TOutput;
  handler: (
    state: z.output<TState>,
    context: RuntimeToolHandlerContext<TId>,
  ) => z.output<TOutput> | Promise<z.output<TOutput>>;
}

export interface RuntimeAsyncOperationConfig<
  TStartInput extends ZodObject,
  TId extends ZodObject,
  TState extends ZodType,
  TSnapshot extends ZodType,
  TCancel extends AsyncOperationCancelCapability<TId, TState> = never,
  TResult extends AsyncOperationOutputCapability<TId, TState, ZodType> = never,
  TArtifacts extends AsyncOperationOutputCapability<TId, TState, ZodType> = never,
> {
  mode: 'runtime-only';
  /** Provider-safe prefix used for the generated capability names. */
  name: string;
  description: string;
  identity: AsyncOperationIdentity;
  startInput: TStartInput;
  id: TId;
  state: TState;
  snapshot: TSnapshot;
  start: (
    input: z.output<TStartInput>,
    context: RuntimeToolHandlerContext<TStartInput>,
  ) => z.output<TId> | Promise<z.output<TId>>;
  /** Mandatory resource authorization, repeated before every follow-up callback. */
  authorize: (
    id: z.output<TId>,
    capability: Exclude<AsyncOperationCapability, 'start'>,
    context: RuntimeToolHandlerContext<TId>,
  ) => void | Promise<void>;
  inspect: (
    id: z.output<TId>,
    context: RuntimeToolHandlerContext<TId>,
  ) => z.output<TState> | Promise<z.output<TState>>;
  classify: (
    state: z.output<TState>,
    context: RuntimeToolHandlerContext<TId>,
  ) => z.output<TSnapshot> | Promise<z.output<TSnapshot>>;
  cancel?: TCancel;
  result?: TResult;
  artifacts?: TArtifacts;
  names?: Partial<Record<AsyncOperationCapability, string>>;
  descriptions?: Partial<Record<AsyncOperationCapability, string>>;
  scopes?: Partial<Record<AsyncOperationCapability, string>>;
  annotations?: Partial<Record<AsyncOperationCapability, EndpointToolAnnotations>>;
  transports?: Partial<Record<AsyncOperationCapability, readonly RuntimeToolTransport[]>>;
  backoff?: number[];
  defaultTimeout?: number;
  timeoutFromId?: (id: z.output<TId>) => number | undefined;
}

export type AsyncOperationStartDefinition<
  TInput extends ZodObject,
  TId extends ZodObject,
> = RuntimeToolDefinitionWithOutput<TInput, TId>;
export type AsyncOperationFollowDefinition<
  TId extends ZodObject,
  TOutput extends ZodType,
> = RuntimeToolDefinitionWithOutput<TId, TOutput>;

export type RuntimeAsyncOperation<
  TStartInput extends ZodObject,
  TId extends ZodObject,
  TSnapshot extends ZodType,
  TCancel,
  TResult,
  TArtifacts,
> = {
  start: AsyncOperationStartDefinition<TStartInput, TId>;
  status: AsyncOperationFollowDefinition<TId, TSnapshot>;
  wait: AsyncOperationFollowDefinition<TId, TSnapshot>;
  runtimeTools: readonly RuntimeToolDefinition[];
  schemas: {
    id: TId;
    snapshot: TSnapshot;
    cancelResult: typeof AsyncOperationCancelResultSchema;
  };
} & ([TCancel] extends [never]
  ? object
  : { cancel: AsyncOperationFollowDefinition<TId, typeof AsyncOperationCancelResultSchema> }) &
  ([TResult] extends [never]
    ? object
    : TResult extends { output: infer TOutput extends ZodType }
      ? { result: AsyncOperationFollowDefinition<TId, TOutput> }
      : object) &
  ([TArtifacts] extends [never]
    ? object
    : TArtifacts extends { output: infer TOutput extends ZodType }
      ? { artifacts: AsyncOperationFollowDefinition<TId, TOutput> }
      : object);

function terminal(snapshot: unknown): boolean {
  if (typeof snapshot !== 'object' || snapshot === null || !('phase' in snapshot)) {
    return false;
  }
  return (
    snapshot.phase === 'succeeded' ||
    snapshot.phase === 'failed' ||
    snapshot.phase === 'cancelled'
  );
}

function succeeded(snapshot: unknown): boolean {
  return (
    typeof snapshot === 'object' &&
    snapshot !== null &&
    'phase' in snapshot &&
    snapshot.phase === 'succeeded'
  );
}

/** Define a pathless async-operation surface. It never creates an HTTP route. */
export function defineAsyncOperation<
  TStartInput extends ZodObject,
  TId extends ZodObject,
  TState extends ZodType,
  TSnapshot extends ZodType,
  TCancel extends AsyncOperationCancelCapability<TId, TState> = never,
  TResult extends AsyncOperationOutputCapability<TId, TState, ZodType> = never,
  TArtifacts extends AsyncOperationOutputCapability<TId, TState, ZodType> = never,
>(
  config: RuntimeAsyncOperationConfig<
    TStartInput,
    TId,
    TState,
    TSnapshot,
    TCancel,
    TResult,
    TArtifacts
  >,
): RuntimeAsyncOperation<TStartInput, TId, TSnapshot, TCancel, TResult, TArtifacts>;
export function defineAsyncOperation<
  TStartInput extends ZodObject,
  TId extends ZodObject,
  TState extends ZodType,
  TSnapshot extends ZodType,
  TCancel extends AsyncOperationCancelCapability<TId, TState>,
  TResult extends AsyncOperationOutputCapability<TId, TState, ZodType>,
  TArtifacts extends AsyncOperationOutputCapability<TId, TState, ZodType>,
>(
  config: RuntimeAsyncOperationConfig<
    TStartInput,
    TId,
    TState,
    TSnapshot,
    TCancel,
    TResult,
    TArtifacts
  >,
): unknown {
  const capabilityName = (capability: AsyncOperationCapability): string =>
    config.names?.[capability] ?? `${config.name}_${capability}`;
  const description = (capability: AsyncOperationCapability): string =>
    config.descriptions?.[capability] ?? `${config.description}: ${capability}`;
  const identity = (
    capability: AsyncOperationCapability,
    method: HttpMethod,
  ): RuntimeToolIdentity => ({
    serviceName: config.identity.serviceName,
    action: `${config.identity.action}.${capability}`,
    scope: config.scopes?.[capability] ?? config.identity.scope,
    meta: config.identity.meta,
    method,
  });
  const common = (capability: AsyncOperationCapability) => ({
    name: capabilityName(capability),
    description: description(capability),
    transports: config.transports?.[capability],
    annotations:
      config.annotations?.[capability] ??
      (capability === 'start' || capability === 'cancel'
        ? { destructiveHint: true }
        : undefined),
  });

  const inspect = async (
    capability: Exclude<AsyncOperationCapability, 'start'>,
    context: RuntimeToolHandlerContext<TId>,
  ): Promise<{ state: z.output<TState>; snapshot: z.output<TSnapshot> }> => {
    await config.authorize(context.input, capability, context);
    const state = config.state.parse(await config.inspect(context.input, context));
    const snapshot = config.snapshot.parse(await config.classify(state, context));
    return { state, snapshot };
  };

  const start = defineRuntimeTool({
    ...common('start'),
    identity: identity('start', 'POST'),
    input: config.startInput,
    output: config.id,
    handler: (context) => config.start(context.input, context),
  });
  const status = defineRuntimeTool({
    ...common('status'),
    identity: identity('status', 'GET'),
    input: config.id,
    output: config.snapshot,
    handler: async (context) => (await inspect('status', context)).snapshot,
  });
  const wait = defineWaitTool({
    ...common('wait'),
    identity: identity('wait', 'GET'),
    input: config.id,
    state: config.snapshot,
    poll: async (_id, context) => (await inspect('wait', context)).snapshot,
    done: terminal,
    backoff: config.backoff,
    defaultTimeout: config.defaultTimeout,
    timeoutFromInput: config.timeoutFromId,
  });

  const definitions: Record<string, RuntimeToolDefinition> = { start, status, wait };
  const names = new Set<string>();

  if (config.cancel) {
    const capability = config.cancel;
    definitions.cancel = defineRuntimeTool({
      ...common('cancel'),
      identity: identity('cancel', 'DELETE'),
      input: config.id,
      output: AsyncOperationCancelResultSchema,
      handler: async (context) => {
        const inspected = await inspect('cancel', context);
        return capability.handler(inspected.state, context);
      },
    });
  }
  if (config.result) {
    const capability = config.result;
    definitions.result = defineRuntimeTool({
      ...common('result'),
      identity: identity('result', 'GET'),
      input: config.id,
      output: capability.output,
      handler: async (context) => {
        const inspected = await inspect('result', context);
        if (!succeeded(inspected.snapshot)) {
          throw new AppError(
            'OPERATION_NOT_SUCCEEDED',
            'Operation result is not available',
            409,
          );
        }
        return capability.handler(inspected.state, context);
      },
    });
  }
  if (config.artifacts) {
    const capability = config.artifacts;
    definitions.artifacts = defineRuntimeTool({
      ...common('artifacts'),
      identity: identity('artifacts', 'GET'),
      input: config.id,
      output: capability.output,
      handler: async (context) => {
        const inspected = await inspect('artifacts', context);
        if (!succeeded(inspected.snapshot)) {
          throw new AppError(
            'OPERATION_NOT_SUCCEEDED',
            'Operation artifacts are not available',
            409,
          );
        }
        return capability.handler(inspected.state, context);
      },
    });
  }

  for (const definition of Object.values(definitions)) {
    assertUniqueToolName(definition.name, names.has(definition.name), 'in-process tool name');
    names.add(definition.name);
  }
  return {
    ...definitions,
    runtimeTools: Object.values(definitions),
    schemas: {
      id: config.id,
      snapshot: config.snapshot,
      cancelResult: AsyncOperationCancelResultSchema,
    },
  };
}

export type ContractAsyncOperationKeys<TEndpoints extends Record<string, EndpointDef>> =
  keyof TEndpoints & string;

type EndpointInputSchema<TEndpoint> = TEndpoint extends {
  input: infer TSchema extends ZodType;
}
  ? TSchema
  : never;

type EndpointOutputSchema<TEndpoint> = TEndpoint extends {
  output: infer TSchema extends ZodType;
}
  ? TSchema
  : never;

type TypesEqual<TLeft, TRight> = [TLeft] extends [TRight]
  ? [TRight] extends [TLeft]
    ? true
    : false
  : false;

type SchemasEquivalent<TLeft extends ZodType, TRight extends ZodType> =
  TypesEqual<z.input<TLeft>, z.input<TRight>> extends true
    ? TypesEqual<z.output<TLeft>, z.output<TRight>>
    : false;

export type ContractAsyncOperationStartKey<TEndpoints extends Record<string, EndpointDef>> = {
  [TKey in keyof TEndpoints]: EndpointOutputSchema<TEndpoints[TKey]> extends never
    ? never
    : TKey;
}[keyof TEndpoints] &
  string;

export type ContractAsyncOperationFollowKey<
  TEndpoints extends Record<string, EndpointDef>,
  TStart extends ContractAsyncOperationStartKey<TEndpoints>,
> = {
  [TKey in keyof TEndpoints]: EndpointInputSchema<
    TEndpoints[TKey]
  > extends infer TInput extends ZodType
    ? EndpointOutputSchema<TEndpoints[TStart]> extends infer TId extends ZodType
      ? SchemasEquivalent<TInput, TId> extends true
        ? TKey
        : never
      : never
    : never;
}[keyof TEndpoints] &
  string;

export type ContractAsyncOperationWaitKey<
  TEndpoints extends Record<string, EndpointDef>,
  TStart extends ContractAsyncOperationStartKey<TEndpoints>,
  TStatus extends ContractAsyncOperationFollowKey<TEndpoints, TStart>,
> = {
  [TKey in keyof TEndpoints]: TKey extends ContractAsyncOperationFollowKey<TEndpoints, TStart>
    ? EndpointOutputSchema<TEndpoints[TKey]> extends infer TOutput extends ZodType
      ? EndpointOutputSchema<TEndpoints[TStatus]> extends infer TSnapshot extends ZodType
        ? SchemasEquivalent<TOutput, TSnapshot> extends true
          ? TKey
          : never
        : never
      : never
    : never;
}[keyof TEndpoints] &
  string;

export interface ContractAsyncOperationConfig<
  TEndpoints extends Record<string, EndpointDef>,
  TScope extends string,
  TStart extends
    ContractAsyncOperationStartKey<TEndpoints> = ContractAsyncOperationStartKey<TEndpoints>,
  TStatus extends ContractAsyncOperationFollowKey<
    TEndpoints,
    TStart
  > = ContractAsyncOperationFollowKey<TEndpoints, TStart>,
> {
  mode: 'contract-backed';
  contract: ContractDef<TEndpoints, TScope>;
  capabilities: {
    start: TStart;
    status: TStatus;
    wait: ContractAsyncOperationWaitKey<TEndpoints, TStart, TStatus>;
    cancel?: ContractAsyncOperationFollowKey<TEndpoints, TStart>;
    result?: ContractAsyncOperationFollowKey<TEndpoints, TStart>;
    artifacts?: ContractAsyncOperationFollowKey<TEndpoints, TStart>;
  };
  handlers: Handlers<TEndpoints>;
}

/**
 * Bind a dedicated contract's already-declared methods as one async operation.
 * The returned handlers go straight to `implement`; no schema or HTTP route is copied.
 */
export function bindContractAsyncOperation<
  TEndpoints extends Record<string, EndpointDef>,
  TScope extends string,
  const TStart extends ContractAsyncOperationStartKey<TEndpoints>,
  const TStatus extends ContractAsyncOperationFollowKey<TEndpoints, TStart>,
>(config: ContractAsyncOperationConfig<TEndpoints, TScope, TStart, TStatus>) {
  const endpoint = (key: ContractAsyncOperationKeys<TEndpoints>): EndpointDef => {
    const found = config.contract.endpoints[key];
    if (!found) throw new Error(`Contract async operation method "${key}" not found`);
    return found;
  };
  const start = endpoint(config.capabilities.start);
  const status = endpoint(config.capabilities.status);
  const wait = endpoint(config.capabilities.wait);
  if (!start.output || !status.output || !wait.output) {
    throw new Error('Contract async operation requires outputs for start, status and wait');
  }
  if (status.input !== start.output || wait.input !== start.output) {
    const capability = status.input !== start.output ? 'status' : 'wait';
    throw new Error(
      `Contract async operation capability "${capability}" input must reuse the same schema instance as the start output`,
    );
  }
  if (wait.output !== status.output) {
    throw new Error(
      'Contract async operation capability "wait" output must reuse the same schema instance as the status output',
    );
  }
  const validateOptional = (capability: 'cancel' | 'result' | 'artifacts'): void => {
    const key = config.capabilities[capability];
    if (key && endpoint(key).input !== start.output) {
      throw new Error(
        `Contract async operation capability "${capability}" input must reuse the same schema instance as the start output`,
      );
    }
  };
  validateOptional('cancel');
  validateOptional('result');
  validateOptional('artifacts');
  return {
    contract: config.contract,
    handlers: config.handlers,
    capabilities: config.capabilities,
    schemas: { id: start.output, snapshot: status.output },
  };
}
