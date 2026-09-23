import type { ZodType, z } from 'zod';
import type { ContractDef, EndpointDef } from '../../contract/define';
import type { Handlers } from '../../server/types';
import type {
  AdaptedContractAsyncOperationConfig,
  AdaptedContractAsyncOperationFollowKey,
  AdaptedContractAsyncOperationStartKey,
  AdaptedContractAsyncOperationWaitKey,
  BoundAdaptedContractAsyncOperation,
  ContractAsyncOperationConfig,
  ContractAsyncOperationInputAdapters,
  ContractEndpointsOf,
  ContractScopeOf,
  DirectContractAsyncOperationCapabilities,
  DirectContractAsyncOperationConstraint,
} from './async-operation-binding-types';
import type { AsyncOperationCapability } from './async-operation-contract';
import {
  adapterResult,
  assertWireStableIdSchema,
  type ContractAsyncOperationKeys,
  type EndpointOutputSchema,
} from './async-operation-id';

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
  const resolved: ResolvedBinding<TEndpoints> = {
    endpoint,
    status,
    wait,
    startOutput,
    statusOutput,
  };
  if (config.binding !== 'adapted') return bindDirect(config, resolved);
  return bindAdapted(config, resolved);
}

/** The endpoints both bindings read, resolved and checked once before either runs. */
interface ResolvedBinding<TEndpoints extends Record<string, EndpointDef>> {
  endpoint: (key: ContractAsyncOperationKeys<TEndpoints>) => EndpointDef;
  status: EndpointDef;
  wait: EndpointDef;
  startOutput: ZodType;
  statusOutput: ZodType;
}

const OPTIONAL_CAPABILITIES: readonly ('cancel' | 'result' | 'artifacts')[] = [
  'cancel',
  'result',
  'artifacts',
];

/** Direct binding: every follow-up input IS the start output, by schema identity. */
function bindDirect<TEndpoints extends Record<string, EndpointDef>, TScope extends string>(
  config: ContractAsyncOperationConfig<TEndpoints, TScope>,
  { endpoint, status, wait, startOutput, statusOutput }: ResolvedBinding<TEndpoints>,
): unknown {
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
  for (const capability of OPTIONAL_CAPABILITIES) {
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

/** Adapted binding: an application-owned ID schema, translated to each endpoint's input. */
function bindAdapted<
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
  config: AdaptedContractAsyncOperationConfig<
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
  { endpoint, statusOutput }: ResolvedBinding<TEndpoints>,
): unknown {
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
