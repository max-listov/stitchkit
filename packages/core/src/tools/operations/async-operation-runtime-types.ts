import type { ZodObject, ZodType, z } from 'zod';
import type { EndpointToolAnnotations, ToolTransport } from '../../contract/define';
import type {
  RuntimeToolDefinition,
  RuntimeToolDefinitionWithOutput,
  RuntimeToolHandlerContext,
} from '../runtime-tool';
import type {
  AsyncOperationCancelResultSchema,
  AsyncOperationCapability,
} from './async-operation-contract';

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
  transports?: Partial<Record<AsyncOperationCapability, readonly ToolTransport[]>>;
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
