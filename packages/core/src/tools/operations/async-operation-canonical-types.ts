import type { ZodType, z } from 'zod';
import type { ContractDef, EndpointDef, HttpMethod, Transport } from '../../contract/define';
import type {
  AsyncOperationCancelResultSchema,
  AsyncOperationCapability,
} from './async-operation-contract';
import type { StableSchema } from './async-operation-id';

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

export interface AsyncOperationContractBaseConfig<
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
  /**
   * Which transports carry each capability. Absent, an endpoint is a tool on
   * every transport, which is the framework default.
   *
   * It has to be declarable HERE because this contract is built inside the
   * framework: an application that made tools opt-in with
   * `createContractFactory({ toolExposure: 'explicit' })` set that default on
   * its OWN factory, and these endpoints never pass through it. Without this
   * field a consumer who had decided that agents get only the tools it names
   * was still handed `start` and `cancel` — both effectful — with no way to say
   * otherwise short of rebuilding the contract by hand.
   *
   * The default is unchanged on purpose. Unlike the tracking ingest, an async
   * operation is a plausible thing for an agent to start and follow, so this
   * says who decides rather than deciding for everyone.
   */
  expose?: Partial<Record<AsyncOperationCapability, readonly Transport[]>>;
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
