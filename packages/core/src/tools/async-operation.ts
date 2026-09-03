import { type ZodObject, type ZodType, z } from 'zod';
import {
  AsyncOperationCancelResultSchema,
  type AsyncOperationCapability,
} from './async-operation-contract';

export {
  type AsyncOperationCancelResult,
  AsyncOperationCancelResultSchema,
  type AsyncOperationCapability,
  type AsyncOperationSnapshotSchema,
  type AsyncOperationSnapshotSchemaWithProgress,
  createAsyncOperationSnapshotSchema,
} from './async-operation-contract';

import type {
  ContractDef,
  EndpointDef,
  EndpointToolAnnotations,
  HttpMethod,
} from '../contract';
import { AppError, defineContract } from '../contract';
import { isRecord } from '../internal/typed';
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

type StableSchema<TSchema extends ZodType> =
  TypesEqual<z.input<TSchema>, z.output<TSchema>> extends true ? TSchema : never;

type SchemasEquivalent<TLeft extends ZodType, TRight extends ZodType> =
  TypesEqual<z.input<TLeft>, z.input<TRight>> extends true
    ? TypesEqual<z.output<TLeft>, z.output<TRight>>
    : false;

type CanonicalAsyncOperationEndpoint<
  TMethod extends Exclude<HttpMethod, 'HEAD'>,
  TPath extends string,
  TInput extends ZodType,
  TOutput extends ZodType,
  TScopeField extends object,
> = {
  method: TMethod;
  path: TPath;
  desc: string;
  input: TInput;
  output: TOutput;
} & TScopeField;

type CapabilityScopeField<TScopes, TCapability extends AsyncOperationCapability> =
  TScopes extends Partial<Record<AsyncOperationCapability, string>>
    ? TCapability extends keyof TScopes
      ? { scope: Extract<TScopes[TCapability], string> }
      : Record<never, never>
    : Record<never, never>;

type CanonicalAsyncOperationEndpoints<
  TStartInput extends ZodType,
  TId extends ZodType,
  TSnapshot extends ZodType,
  TStartOutput extends ZodType,
  TCancel,
  TResult,
  TArtifacts,
  TScopes,
> = {
  start: CanonicalAsyncOperationEndpoint<
    'POST',
    '/',
    TStartInput,
    TStartOutput,
    CapabilityScopeField<TScopes, 'start'>
  >;
  status: CanonicalAsyncOperationEndpoint<
    'POST',
    '/status',
    TId,
    TSnapshot,
    CapabilityScopeField<TScopes, 'status'>
  >;
  wait: CanonicalAsyncOperationEndpoint<
    'POST',
    '/wait',
    TId,
    TSnapshot,
    CapabilityScopeField<TScopes, 'wait'>
  >;
} & ([TCancel] extends [true]
  ? {
      cancel: CanonicalAsyncOperationEndpoint<
        'POST',
        '/cancel',
        TId,
        typeof AsyncOperationCancelResultSchema,
        CapabilityScopeField<TScopes, 'cancel'>
      >;
    }
  : object) &
  ([TResult] extends [ZodType]
    ? {
        result: CanonicalAsyncOperationEndpoint<
          'POST',
          '/result',
          TId,
          TResult,
          CapabilityScopeField<TScopes, 'result'>
        >;
      }
    : object) &
  ([TArtifacts] extends [ZodType]
    ? {
        artifacts: CanonicalAsyncOperationEndpoint<
          'POST',
          '/artifacts',
          TId,
          TArtifacts,
          CapabilityScopeField<TScopes, 'artifacts'>
        >;
      }
    : object);

type CanonicalAsyncOperationCapabilities<TCancel, TResult, TArtifacts> = {
  start: 'start';
  status: 'status';
  wait: 'wait';
} & ([TCancel] extends [true] ? { cancel: 'cancel' } : object) &
  ([TResult] extends [ZodType] ? { result: 'result' } : object) &
  ([TArtifacts] extends [ZodType] ? { artifacts: 'artifacts' } : object);

type CanonicalAsyncOperationInputFor<TId extends ZodType, TCancel, TResult, TArtifacts> = {
  status: (id: z.output<TId>) => z.output<TId>;
  wait: (id: z.output<TId>) => z.output<TId>;
} & ([TCancel] extends [true] ? { cancel: (id: z.output<TId>) => z.output<TId> } : object) &
  ([TResult] extends [ZodType] ? { result: (id: z.output<TId>) => z.output<TId> } : object) &
  ([TArtifacts] extends [ZodType]
    ? { artifacts: (id: z.output<TId>) => z.output<TId> }
    : object);

type CanonicalAsyncOperationSchemas<
  TStartInput extends ZodType,
  TId extends ZodType,
  TSnapshot extends ZodType,
  TStartOutput extends ZodType,
  TCancel,
  TResult,
  TArtifacts,
> = {
  startInput: TStartInput;
  startOutput: TStartOutput;
  id: TId;
  snapshot: TSnapshot;
  cancelResult: typeof AsyncOperationCancelResultSchema;
} & ([TCancel] extends [true] ? { cancel: typeof AsyncOperationCancelResultSchema } : object) &
  ([TResult] extends [ZodType] ? { result: TResult } : object) &
  ([TArtifacts] extends [ZodType] ? { artifacts: TArtifacts } : object);

type EndpointRecord<TEndpoints> =
  TEndpoints extends Record<string, EndpointDef> ? TEndpoints : never;

interface AsyncOperationContractBaseConfig<
  TStartInput extends ZodType,
  TId extends ZodType,
  TSnapshot extends ZodType,
  TCancel extends true | undefined = undefined,
  TResult extends ZodType | undefined = undefined,
  TArtifacts extends ZodType | undefined = undefined,
  TScope extends string = 'public',
  TScopes extends Partial<Record<AsyncOperationCapability, string>> = Record<never, never>,
> {
  prefix: string;
  scope?: TScope;
  description: string;
  startInput: TStartInput;
  /** Canonical follow-up inputs use the ID value directly, so input/output must be stable. */
  id: StableSchema<TId>;
  snapshot: TSnapshot;
  cancel?: TCancel;
  result?: TResult;
  artifacts?: TArtifacts;
  descriptions?: Partial<Record<AsyncOperationCapability, string>>;
  scopes?: TScopes;
}

export type AsyncOperationContractConfig<
  TStartInput extends ZodType,
  TId extends ZodType,
  TSnapshot extends ZodType,
  TCancel extends true | undefined = undefined,
  TResult extends ZodType | undefined = undefined,
  TArtifacts extends ZodType | undefined = undefined,
  TScope extends string = 'public',
  TScopes extends Partial<Record<AsyncOperationCapability, string>> = Record<never, never>,
> = AsyncOperationContractBaseConfig<
  TStartInput,
  TId,
  TSnapshot,
  TCancel,
  TResult,
  TArtifacts,
  TScope,
  TScopes
> & {
  startOutput?: never;
  idFromStart?: never;
};

export type AsyncOperationContractWithStartOutputConfig<
  TStartInput extends ZodType,
  TId extends ZodType,
  TSnapshot extends ZodType,
  TStartOutput extends ZodType,
  TCancel extends true | undefined = undefined,
  TResult extends ZodType | undefined = undefined,
  TArtifacts extends ZodType | undefined = undefined,
  TScope extends string = 'public',
  TScopes extends Partial<Record<AsyncOperationCapability, string>> = Record<never, never>,
> = AsyncOperationContractBaseConfig<
  TStartInput,
  TId,
  TSnapshot,
  TCancel,
  TResult,
  TArtifacts,
  TScope,
  TScopes
> & {
  startOutput: TStartOutput;
  idFromStart: (output: z.output<TStartOutput>) => z.input<TId>;
};

export interface DefinedAsyncOperationContract<
  TStartInput extends ZodType,
  TId extends ZodType,
  TSnapshot extends ZodType,
  TStartOutput extends ZodType,
  TCancel extends true | undefined,
  TResult extends ZodType | undefined,
  TArtifacts extends ZodType | undefined,
  TScope extends string = 'public',
  TScopes extends Partial<Record<AsyncOperationCapability, string>> = Record<never, never>,
> {
  contract: ContractDef<
    EndpointRecord<
      CanonicalAsyncOperationEndpoints<
        TStartInput,
        TId,
        TSnapshot,
        TStartOutput,
        TCancel,
        TResult,
        TArtifacts,
        TScopes
      >
    >,
    TScope
  >;
  capabilities: CanonicalAsyncOperationCapabilities<TCancel, TResult, TArtifacts>;
  schemas: CanonicalAsyncOperationSchemas<
    TStartInput,
    TId,
    TSnapshot,
    TStartOutput,
    TCancel,
    TResult,
    TArtifacts
  >;
  adapters: {
    idFromStart: (output: z.output<TStartOutput>) => z.output<TId>;
    inputFor: CanonicalAsyncOperationInputFor<TId, TCancel, TResult, TArtifacts>;
  };
}

function adapterResult<TSchema extends ZodType>(
  capability: AsyncOperationCapability,
  target: 'id' | 'input',
  schema: TSchema,
  value: unknown,
): z.output<TSchema> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `Async operation adapter for capability "${capability}" returned invalid ${target}`,
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

const NON_WIRE_STABLE_ZOD_TYPES = new Set([
  'catch',
  'default',
  'lazy',
  'pipe',
  'prefault',
  'readonly',
  'success',
  'transform',
]);

function hasOverwriteCheck(value: unknown): boolean {
  return (
    isRecord(value) &&
    isRecord(value._zod) &&
    isRecord(value._zod.def) &&
    value._zod.def.check === 'overwrite'
  );
}

/** Direct adapters parse an ID more than once, so their schema must preserve parsed values. */
function assertWireStableIdSchema(schema: ZodType, boundary: string): void {
  const visited = new Set<object>();
  const pending: unknown[] = [schema];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value !== 'object' || value === null || visited.has(value)) continue;
    visited.add(value);
    if (value instanceof z.ZodType) {
      const definition = value._zod.def;
      if (
        NON_WIRE_STABLE_ZOD_TYPES.has(definition.type) ||
        ('coerce' in definition && definition.coerce === true) ||
        ('checks' in definition &&
          Array.isArray(definition.checks) &&
          definition.checks.some(hasOverwriteCheck))
      ) {
        throw new Error(
          `${boundary} must use a wire-stable ID schema without transforms, coercion, defaults or overwrites; use binding: "adapted" with explicit ID adapters`,
        );
      }
      pending.push(...Object.values(definition));
      continue;
    }
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    if (isRecord(value)) pending.push(...Object.values(value));
  }
}

/** Define the canonical HTTP contract shape for an async operation. */
export function defineAsyncOperationContract<
  TStartInput extends ZodType,
  TId extends ZodType,
  TSnapshot extends ZodType,
  TCancel extends true | undefined = undefined,
  TResult extends ZodType | undefined = undefined,
  TArtifacts extends ZodType | undefined = undefined,
  TScope extends string = 'public',
  const TScopes extends Partial<Record<AsyncOperationCapability, string>> = Record<
    never,
    never
  >,
>(
  config: AsyncOperationContractConfig<
    TStartInput,
    TId,
    TSnapshot,
    TCancel,
    TResult,
    TArtifacts,
    TScope,
    TScopes
  >,
): DefinedAsyncOperationContract<
  TStartInput,
  TId,
  TSnapshot,
  TId,
  TCancel,
  TResult,
  TArtifacts,
  TScope,
  TScopes
>;
export function defineAsyncOperationContract<
  TStartInput extends ZodType,
  TId extends ZodType,
  TSnapshot extends ZodType,
  TStartOutput extends ZodType,
  TCancel extends true | undefined = undefined,
  TResult extends ZodType | undefined = undefined,
  TArtifacts extends ZodType | undefined = undefined,
  TScope extends string = 'public',
  const TScopes extends Partial<Record<AsyncOperationCapability, string>> = Record<
    never,
    never
  >,
>(
  config: AsyncOperationContractWithStartOutputConfig<
    TStartInput,
    TId,
    TSnapshot,
    TStartOutput,
    TCancel,
    TResult,
    TArtifacts,
    TScope,
    TScopes
  >,
): DefinedAsyncOperationContract<
  TStartInput,
  TId,
  TSnapshot,
  TStartOutput,
  TCancel,
  TResult,
  TArtifacts,
  TScope,
  TScopes
>;
export function defineAsyncOperationContract<
  TStartInput extends ZodType,
  TId extends ZodType,
  TSnapshot extends ZodType,
  TStartOutput extends ZodType,
  TCancel extends true | undefined,
  TResult extends ZodType | undefined,
  TArtifacts extends ZodType | undefined,
  TScope extends string,
  TScopes extends Partial<Record<AsyncOperationCapability, string>>,
>(
  config:
    | AsyncOperationContractConfig<
        TStartInput,
        TId,
        TSnapshot,
        TCancel,
        TResult,
        TArtifacts,
        TScope,
        TScopes
      >
    | AsyncOperationContractWithStartOutputConfig<
        TStartInput,
        TId,
        TSnapshot,
        TStartOutput,
        TCancel,
        TResult,
        TArtifacts,
        TScope,
        TScopes
      >,
): unknown {
  assertWireStableIdSchema(config.id, 'Async operation contract');
  const hasStartOutput = config.startOutput !== undefined;
  const hasIdFromStart = config.idFromStart !== undefined;
  if (hasStartOutput !== hasIdFromStart) {
    throw new Error(
      'Async operation contract startOutput and idFromStart must be configured together',
    );
  }
  const description = (capability: AsyncOperationCapability): string =>
    config.descriptions?.[capability] ?? `${config.description}: ${capability}`;
  const endpoint = <
    TMethod extends Exclude<HttpMethod, 'HEAD'>,
    TPath extends string,
    TInput extends ZodType,
    TOutput extends ZodType,
  >(
    capability: AsyncOperationCapability,
    method: TMethod,
    path: TPath,
    input: TInput,
    output: TOutput,
  ): EndpointDef => {
    const scope = config.scopes?.[capability];
    return {
      method,
      path,
      desc: description(capability),
      input,
      output,
      ...(scope !== undefined && { scope }),
    };
  };
  const startOutput: ZodType = config.startOutput ?? config.id;
  const endpoints: Record<string, EndpointDef> = {
    start: endpoint('start', 'POST', '/', config.startInput, startOutput),
    status: endpoint('status', 'POST', '/status', config.id, config.snapshot),
    wait: endpoint('wait', 'POST', '/wait', config.id, config.snapshot),
  };
  const capabilities: Record<string, string> = {
    start: 'start',
    status: 'status',
    wait: 'wait',
  };
  const schemas: Record<string, ZodType> = {
    startInput: config.startInput,
    startOutput,
    id: config.id,
    snapshot: config.snapshot,
    cancelResult: AsyncOperationCancelResultSchema,
  };
  const inputFor: Record<string, (id: unknown) => unknown> = {
    status: (id) => adapterResult('status', 'input', config.id, id),
    wait: (id) => adapterResult('wait', 'input', config.id, id),
  };
  if (config.cancel) {
    endpoints.cancel = endpoint(
      'cancel',
      'POST',
      '/cancel',
      config.id,
      AsyncOperationCancelResultSchema,
    );
    capabilities.cancel = 'cancel';
    schemas.cancel = AsyncOperationCancelResultSchema;
    inputFor.cancel = (id) => adapterResult('cancel', 'input', config.id, id);
  }
  if (config.result) {
    endpoints.result = endpoint('result', 'POST', '/result', config.id, config.result);
    capabilities.result = 'result';
    schemas.result = config.result;
    inputFor.result = (id) => adapterResult('result', 'input', config.id, id);
  }
  if (config.artifacts) {
    endpoints.artifacts = endpoint(
      'artifacts',
      'POST',
      '/artifacts',
      config.id,
      config.artifacts,
    );
    capabilities.artifacts = 'artifacts';
    schemas.artifacts = config.artifacts;
    inputFor.artifacts = (id) => adapterResult('artifacts', 'input', config.id, id);
  }
  const contract = config.scope
    ? defineContract({ prefix: config.prefix, scope: config.scope }, endpoints)
    : defineContract({ prefix: config.prefix }, endpoints);
  const applicationStartOutput = config.startOutput;
  const applicationIdFromStart = config.idFromStart;
  const idFromStart =
    applicationStartOutput && applicationIdFromStart
      ? (output: z.output<TStartOutput>): unknown =>
          adapterResult('start', 'id', config.id, applicationIdFromStart(output))
      : (output: z.output<TId>): unknown => adapterResult('start', 'id', config.id, output);
  return {
    contract,
    capabilities,
    schemas,
    adapters: { idFromStart, inputFor },
  };
}

export type AdaptedContractAsyncOperationStartKey<
  TEndpoints extends Record<string, EndpointDef>,
> = {
  [TKey in keyof TEndpoints]: EndpointOutputSchema<TEndpoints[TKey]> extends never
    ? never
    : TKey;
}[keyof TEndpoints] &
  string;

export type ContractAsyncOperationStartKey<TEndpoints extends Record<string, EndpointDef>> = {
  [TKey in AdaptedContractAsyncOperationStartKey<TEndpoints>]: EndpointOutputSchema<
    TEndpoints[TKey]
  > extends infer TOutput extends ZodType
    ? StableSchema<TOutput> extends never
      ? never
      : TKey
    : never;
}[AdaptedContractAsyncOperationStartKey<TEndpoints>] &
  string;

export type AdaptedContractAsyncOperationFollowKey<
  TEndpoints extends Record<string, EndpointDef>,
> = {
  [TKey in keyof TEndpoints]: EndpointInputSchema<TEndpoints[TKey]> extends never
    ? never
    : EndpointOutputSchema<TEndpoints[TKey]> extends never
      ? never
      : TKey;
}[keyof TEndpoints] &
  string;

export type AdaptedContractAsyncOperationWaitKey<
  TEndpoints extends Record<string, EndpointDef>,
  TStatus extends AdaptedContractAsyncOperationFollowKey<TEndpoints>,
> = {
  [TKey in AdaptedContractAsyncOperationFollowKey<TEndpoints>]: EndpointOutputSchema<
    TEndpoints[TKey]
  > extends infer TOutput extends ZodType
    ? EndpointOutputSchema<TEndpoints[TStatus]> extends infer TSnapshot extends ZodType
      ? SchemasEquivalent<TOutput, TSnapshot> extends true
        ? TKey
        : never
      : never
    : never;
}[AdaptedContractAsyncOperationFollowKey<TEndpoints>] &
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
  binding?: 'direct';
  contract: ContractDef<TEndpoints, TScope>;
  capabilities: {
    start: TStart;
    status: ContractAsyncOperationFollowKey<TEndpoints, NoInfer<TStart>> & TStatus;
    wait: ContractAsyncOperationWaitKey<TEndpoints, NoInfer<TStart>, NoInfer<TStatus>>;
    cancel?: ContractAsyncOperationFollowKey<TEndpoints, NoInfer<TStart>>;
    result?: ContractAsyncOperationFollowKey<TEndpoints, NoInfer<TStart>>;
    artifacts?: ContractAsyncOperationFollowKey<TEndpoints, NoInfer<TStart>>;
  };
  handlers: Handlers<NoInfer<TEndpoints>>;
}

export interface AdaptedContractAsyncOperationConfig<
  TEndpoints extends Record<string, EndpointDef>,
  TScope extends string,
  TId extends ZodType,
  TStart extends AdaptedContractAsyncOperationStartKey<TEndpoints>,
  TStatus extends AdaptedContractAsyncOperationFollowKey<TEndpoints>,
  TWait extends AdaptedContractAsyncOperationWaitKey<TEndpoints, TStatus>,
  TCancel extends AdaptedContractAsyncOperationFollowKey<TEndpoints> | undefined = undefined,
  TResult extends AdaptedContractAsyncOperationFollowKey<TEndpoints> | undefined = undefined,
  TArtifacts extends
    | AdaptedContractAsyncOperationFollowKey<TEndpoints>
    | undefined = undefined,
> {
  mode: 'contract-backed';
  binding: 'adapted';
  contract: ContractDef<TEndpoints, TScope>;
  id: TId;
  capabilities: {
    start: TStart;
    status: TStatus;
    wait: TWait;
    cancel?: TCancel;
    result?: TResult;
    artifacts?: TArtifacts;
  };
  adapters: {
    idFromStart: (
      output: z.output<EndpointOutputSchema<TEndpoints[NoInfer<TStart>]>>,
    ) => NoInfer<z.input<TId>>;
    inputFor: {
      status: (
        id: z.output<NoInfer<TId>>,
      ) => z.input<EndpointInputSchema<TEndpoints[NoInfer<TStatus>]>>;
      wait: (
        id: z.output<NoInfer<TId>>,
      ) => z.input<EndpointInputSchema<TEndpoints[NoInfer<TWait>]>>;
    } & ([TCancel] extends [string]
      ? {
          cancel: (
            id: z.output<NoInfer<TId>>,
          ) => z.input<EndpointInputSchema<TEndpoints[NoInfer<TCancel> & keyof TEndpoints]>>;
        }
      : object) &
      ([TResult] extends [string]
        ? {
            result: (
              id: z.output<NoInfer<TId>>,
            ) => z.input<EndpointInputSchema<TEndpoints[NoInfer<TResult> & keyof TEndpoints]>>;
          }
        : object) &
      ([TArtifacts] extends [string]
        ? {
            artifacts: (
              id: z.output<NoInfer<TId>>,
            ) => z.input<
              EndpointInputSchema<TEndpoints[NoInfer<TArtifacts> & keyof TEndpoints]>
            >;
          }
        : object);
  };
  handlers: Handlers<NoInfer<TEndpoints>>;
}

export interface BoundAdaptedContractAsyncOperation<
  TEndpoints extends Record<string, EndpointDef>,
  TScope extends string,
  TId extends ZodType,
  TStart extends AdaptedContractAsyncOperationStartKey<TEndpoints>,
  TStatus extends AdaptedContractAsyncOperationFollowKey<TEndpoints>,
  TWait extends AdaptedContractAsyncOperationWaitKey<TEndpoints, TStatus>,
  TCancel extends AdaptedContractAsyncOperationFollowKey<TEndpoints> | undefined,
  TResult extends AdaptedContractAsyncOperationFollowKey<TEndpoints> | undefined,
  TArtifacts extends AdaptedContractAsyncOperationFollowKey<TEndpoints> | undefined,
> {
  contract: ContractDef<TEndpoints, TScope>;
  handlers: Handlers<TEndpoints>;
  capabilities: {
    start: TStart;
    status: TStatus;
    wait: TWait;
  } & ([TCancel] extends [string] ? { cancel: TCancel } : object) &
    ([TResult] extends [string] ? { result: TResult } : object) &
    ([TArtifacts] extends [string] ? { artifacts: TArtifacts } : object);
  schemas: {
    id: TId;
    snapshot: EndpointOutputSchema<TEndpoints[TStatus]>;
  };
  adapters: {
    idFromStart: (output: z.output<EndpointOutputSchema<TEndpoints[TStart]>>) => z.output<TId>;
    inputFor: {
      status: (id: z.output<TId>) => z.output<EndpointInputSchema<TEndpoints[TStatus]>>;
      wait: (id: z.output<TId>) => z.output<EndpointInputSchema<TEndpoints[TWait]>>;
    } & ([TCancel] extends [string]
      ? {
          cancel: (
            id: z.output<TId>,
          ) => z.output<EndpointInputSchema<TEndpoints[TCancel & keyof TEndpoints]>>;
        }
      : object) &
      ([TResult] extends [string]
        ? {
            result: (
              id: z.output<TId>,
            ) => z.output<EndpointInputSchema<TEndpoints[TResult & keyof TEndpoints]>>;
          }
        : object) &
      ([TArtifacts] extends [string]
        ? {
            artifacts: (
              id: z.output<TId>,
            ) => z.output<EndpointInputSchema<TEndpoints[TArtifacts & keyof TEndpoints]>>;
          }
        : object);
  };
}

type DirectContractAsyncOperationCapabilities<TEndpoints extends Record<string, EndpointDef>> =
  {
    start: ContractAsyncOperationStartKey<TEndpoints>;
    status: ContractAsyncOperationKeys<TEndpoints>;
    wait: ContractAsyncOperationKeys<TEndpoints>;
    cancel?: ContractAsyncOperationKeys<TEndpoints>;
    result?: ContractAsyncOperationKeys<TEndpoints>;
    artifacts?: ContractAsyncOperationKeys<TEndpoints>;
  };

export type ContractAsyncOperationInputAdapters<
  TEndpoints extends Record<string, EndpointDef>,
  TCapabilities extends DirectContractAsyncOperationCapabilities<TEndpoints>,
> = {
  status: (
    id: z.output<EndpointOutputSchema<TEndpoints[TCapabilities['start']]>>,
  ) => z.output<EndpointOutputSchema<TEndpoints[TCapabilities['start']]>>;
  wait: (
    id: z.output<EndpointOutputSchema<TEndpoints[TCapabilities['start']]>>,
  ) => z.output<EndpointOutputSchema<TEndpoints[TCapabilities['start']]>>;
} & (TCapabilities['cancel'] extends string
  ? {
      cancel: (
        id: z.output<EndpointOutputSchema<TEndpoints[TCapabilities['start']]>>,
      ) => z.output<EndpointOutputSchema<TEndpoints[TCapabilities['start']]>>;
    }
  : Record<never, never>) &
  (TCapabilities['result'] extends string
    ? {
        result: (
          id: z.output<EndpointOutputSchema<TEndpoints[TCapabilities['start']]>>,
        ) => z.output<EndpointOutputSchema<TEndpoints[TCapabilities['start']]>>;
      }
    : Record<never, never>) &
  (TCapabilities['artifacts'] extends string
    ? {
        artifacts: (
          id: z.output<EndpointOutputSchema<TEndpoints[TCapabilities['start']]>>,
        ) => z.output<EndpointOutputSchema<TEndpoints[TCapabilities['start']]>>;
      }
    : Record<never, never>);

type ValidDirectFollowCapability<
  TEndpoints extends Record<string, EndpointDef>,
  TCapabilities extends DirectContractAsyncOperationCapabilities<TEndpoints>,
  TCapability extends 'status' | 'cancel' | 'result' | 'artifacts',
> =
  TCapabilities[TCapability] extends ContractAsyncOperationFollowKey<
    TEndpoints,
    TCapabilities['start']
  >
    ? TCapabilities[TCapability]
    : never;

type ValidDirectContractAsyncOperationCapabilities<
  TEndpoints extends Record<string, EndpointDef>,
  TCapabilities extends DirectContractAsyncOperationCapabilities<TEndpoints>,
> = TCapabilities & {
  status: ValidDirectFollowCapability<TEndpoints, TCapabilities, 'status'>;
  wait: TCapabilities['wait'] extends ContractAsyncOperationWaitKey<
    TEndpoints,
    TCapabilities['start'],
    ValidDirectFollowCapability<TEndpoints, TCapabilities, 'status'>
  >
    ? TCapabilities['wait']
    : never;
  cancel?: ValidDirectFollowCapability<TEndpoints, TCapabilities, 'cancel'>;
  result?: ValidDirectFollowCapability<TEndpoints, TCapabilities, 'result'>;
  artifacts?: ValidDirectFollowCapability<TEndpoints, TCapabilities, 'artifacts'>;
};

type DirectContractAsyncOperationConstraint<
  TEndpoints extends Record<string, EndpointDef>,
  TCapabilities extends DirectContractAsyncOperationCapabilities<TEndpoints>,
> =
  TCapabilities extends ValidDirectContractAsyncOperationCapabilities<
    TEndpoints,
    TCapabilities
  >
    ? object
    : never;

type ContractEndpointsOf<TContract extends ContractDef> = TContract['endpoints'];
type ContractScopeOf<TContract extends ContractDef> =
  TContract extends ContractDef<Record<string, EndpointDef>, infer TScope> ? TScope : never;

/**
 * Bind a dedicated contract's already-declared methods as one async operation.
 * The returned handlers go straight to `implement`; no schema or HTTP route is copied.
 */
export function bindContractAsyncOperation<
  const TContract extends ContractDef,
  TId extends ZodType,
  const TStart extends AdaptedContractAsyncOperationStartKey<ContractEndpointsOf<TContract>>,
  const TStatus extends AdaptedContractAsyncOperationFollowKey<ContractEndpointsOf<TContract>>,
  const TWait extends AdaptedContractAsyncOperationWaitKey<
    ContractEndpointsOf<TContract>,
    TStatus
  >,
  const TCancel extends
    | AdaptedContractAsyncOperationFollowKey<ContractEndpointsOf<TContract>>
    | undefined = undefined,
  const TResult extends
    | AdaptedContractAsyncOperationFollowKey<ContractEndpointsOf<TContract>>
    | undefined = undefined,
  const TArtifacts extends
    | AdaptedContractAsyncOperationFollowKey<ContractEndpointsOf<TContract>>
    | undefined = undefined,
>(
  config: Omit<
    AdaptedContractAsyncOperationConfig<
      ContractEndpointsOf<TContract>,
      ContractScopeOf<TContract>,
      TId,
      TStart,
      TStatus,
      TWait,
      TCancel,
      TResult,
      TArtifacts
    >,
    'contract'
  > & { contract: TContract },
): BoundAdaptedContractAsyncOperation<
  ContractEndpointsOf<TContract>,
  ContractScopeOf<TContract>,
  TId,
  TStart,
  TStatus,
  TWait,
  TCancel,
  TResult,
  TArtifacts
>;
export function bindContractAsyncOperation<
  TEndpoints extends Record<string, EndpointDef>,
  TScope extends string,
  const TCapabilities extends DirectContractAsyncOperationCapabilities<TEndpoints>,
>(
  config: Omit<ContractAsyncOperationConfig<TEndpoints, TScope>, 'capabilities'> & {
    capabilities: TCapabilities;
  } & DirectContractAsyncOperationConstraint<TEndpoints, TCapabilities>,
): {
  contract: ContractDef<TEndpoints, TScope>;
  handlers: Handlers<TEndpoints>;
  capabilities: TCapabilities;
  schemas: {
    id: EndpointOutputSchema<TEndpoints[TCapabilities['start']]>;
    snapshot: EndpointOutputSchema<TEndpoints[TCapabilities['status']]>;
  };
  adapters: {
    idFromStart: (
      output: z.output<EndpointOutputSchema<TEndpoints[TCapabilities['start']]>>,
    ) => z.output<EndpointOutputSchema<TEndpoints[TCapabilities['start']]>>;
    inputFor: ContractAsyncOperationInputAdapters<TEndpoints, TCapabilities>;
  };
};
export function bindContractAsyncOperation<
  TEndpoints extends Record<string, EndpointDef>,
  TScope extends string,
  TId extends ZodType,
  TStart extends AdaptedContractAsyncOperationStartKey<TEndpoints>,
  TStatus extends AdaptedContractAsyncOperationFollowKey<TEndpoints>,
  TWait extends AdaptedContractAsyncOperationWaitKey<TEndpoints, TStatus>,
  TCancel extends AdaptedContractAsyncOperationFollowKey<TEndpoints> | undefined,
  TResult extends AdaptedContractAsyncOperationFollowKey<TEndpoints> | undefined,
  TArtifacts extends AdaptedContractAsyncOperationFollowKey<TEndpoints> | undefined,
>(
  config:
    | ContractAsyncOperationConfig<TEndpoints, TScope>
    | AdaptedContractAsyncOperationConfig<
        TEndpoints,
        TScope,
        TId,
        TStart,
        TStatus,
        TWait,
        TCancel,
        TResult,
        TArtifacts
      >,
): unknown {
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
  const startOutput = start.output;
  const statusOutput = status.output;
  if (wait.output !== statusOutput) {
    throw new Error(
      'Contract async operation capability "wait" output must reuse the same schema instance as the status output',
    );
  }
  const optionalCapabilities: readonly ('cancel' | 'result' | 'artifacts')[] = [
    'cancel',
    'result',
    'artifacts',
  ];
  if (config.binding !== 'adapted') {
    assertWireStableIdSchema(startOutput, 'Direct contract async operation');
    if (status.input !== startOutput || wait.input !== startOutput) {
      const capability = status.input !== startOutput ? 'status' : 'wait';
      throw new Error(
        `Contract async operation capability "${capability}" input must reuse the same schema instance as the start output`,
      );
    }
    const inputFor: Record<string, (id: unknown) => unknown> = {
      status: (id) => adapterResult('status', 'input', startOutput, id),
      wait: (id) => adapterResult('wait', 'input', startOutput, id),
    };
    for (const capability of optionalCapabilities) {
      const key = config.capabilities[capability];
      if (!key) continue;
      if (endpoint(key).input !== startOutput) {
        throw new Error(
          `Contract async operation capability "${capability}" input must reuse the same schema instance as the start output`,
        );
      }
      inputFor[capability] = (id) => adapterResult(capability, 'input', startOutput, id);
    }
    return {
      contract: config.contract,
      handlers: config.handlers,
      capabilities: config.capabilities,
      schemas: { id: startOutput, snapshot: statusOutput },
      adapters: {
        idFromStart: (output: unknown) => adapterResult('start', 'id', startOutput, output),
        inputFor,
      },
    };
  }

  const adapters = config.adapters;
  const idSchema = config.id;
  const adaptedInput = (
    capability: Exclude<AsyncOperationCapability, 'start'>,
    key: ContractAsyncOperationKeys<TEndpoints>,
    builder: (id: z.output<TId>) => unknown,
  ) => {
    const input = endpoint(key).input;
    if (!input) {
      throw new Error(
        `Contract async operation capability "${capability}" requires an input schema`,
      );
    }
    return (id: z.output<TId>): unknown =>
      adapterResult(capability, 'input', input, builder(id));
  };
  const inputFor: Record<string, (id: z.output<TId>) => unknown> = {
    status: adaptedInput('status', config.capabilities.status, adapters.inputFor.status),
    wait: adaptedInput('wait', config.capabilities.wait, adapters.inputFor.wait),
  };
  const optionalInput = (
    capability: 'cancel' | 'result' | 'artifacts',
    key: ContractAsyncOperationKeys<TEndpoints> | undefined,
    builder: ((id: z.output<TId>) => unknown) | undefined,
  ): void => {
    if (!key) return;
    if (!builder) {
      throw new Error(
        `Contract async operation capability "${capability}" requires an input adapter`,
      );
    }
    inputFor[capability] = adaptedInput(capability, key, builder);
  };
  optionalInput(
    'cancel',
    config.capabilities.cancel,
    'cancel' in adapters.inputFor ? adapters.inputFor.cancel : undefined,
  );
  optionalInput(
    'result',
    config.capabilities.result,
    'result' in adapters.inputFor ? adapters.inputFor.result : undefined,
  );
  optionalInput(
    'artifacts',
    config.capabilities.artifacts,
    'artifacts' in adapters.inputFor ? adapters.inputFor.artifacts : undefined,
  );
  if (!idSchema) {
    throw new Error('Contract adapted async operation requires an id schema');
  }
  return {
    contract: config.contract,
    handlers: config.handlers,
    capabilities: config.capabilities,
    schemas: { id: idSchema, snapshot: statusOutput },
    adapters: {
      idFromStart: (output: z.output<EndpointOutputSchema<TEndpoints[TStart]>>) =>
        adapterResult('start', 'id', idSchema, adapters.idFromStart(output)),
      inputFor,
    },
  };
}
