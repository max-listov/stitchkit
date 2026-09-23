import type { ZodType, z } from 'zod';
import type { ContractDef, EndpointDef } from '../../contract/define';
import type { Handlers } from '../../server/types';
import type {
  ContractAsyncOperationKeys,
  EndpointInputSchema,
  EndpointOutputSchema,
  SchemasEquivalent,
  StableSchema,
} from './async-operation-id';

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

export type DirectContractAsyncOperationCapabilities<
  TEndpoints extends Record<string, EndpointDef>,
> = {
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

export type DirectContractAsyncOperationConstraint<
  TEndpoints extends Record<string, EndpointDef>,
  TCapabilities extends DirectContractAsyncOperationCapabilities<TEndpoints>,
> =
  TCapabilities extends ValidDirectContractAsyncOperationCapabilities<
    TEndpoints,
    TCapabilities
  >
    ? object
    : never;

export type ContractEndpointsOf<TContract extends ContractDef> = TContract['endpoints'];
export type ContractScopeOf<TContract extends ContractDef> =
  TContract extends ContractDef<Record<string, EndpointDef>, infer TScope> ? TScope : never;
