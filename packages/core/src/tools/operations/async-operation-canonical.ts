import type { ZodType, z } from 'zod';
import type { EndpointDef, HttpMethod } from '../../contract/define';
import { defineContract } from '../../contract/define';
import type {
  AsyncOperationContractBaseConfig,
  AsyncOperationContractConfig,
  AsyncOperationContractWithStartOutputConfig,
  DefinedAsyncOperationContract,
} from './async-operation-canonical-types';
import {
  AsyncOperationCancelResultSchema,
  type AsyncOperationCapability,
} from './async-operation-contract';
import { adapterResult, assertWireStableIdSchema } from './async-operation-id';

/** The config fields the endpoint table reads, independent of the start-output variant. */
type CanonicalEndpointSource = Pick<
  AsyncOperationContractBaseConfig<
    ZodType,
    ZodType,
    ZodType,
    true | undefined,
    ZodType | undefined,
    ZodType | undefined,
    string,
    Partial<Record<AsyncOperationCapability, string>>
  >,
  | 'description'
  | 'descriptions'
  | 'scopes'
  | 'expose'
  | 'startInput'
  | 'id'
  | 'snapshot'
  | 'cancel'
  | 'result'
  | 'artifacts'
>;

/** Everything the canonical contract returns except the contract and the start adapter. */
interface CanonicalEndpointTable {
  endpoints: Record<string, EndpointDef>;
  capabilities: Record<string, string>;
  schemas: Record<string, ZodType>;
  inputFor: Record<string, (id: unknown) => unknown>;
}

/**
 * One row per capability: its endpoint, its capability key, its schema entry and
 * its input adapter are added together, so an optional capability can never be
 * half-declared.
 */
function buildCanonicalEndpointTable(
  config: CanonicalEndpointSource,
  startOutput: ZodType,
): CanonicalEndpointTable {
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
    const expose = config.expose?.[capability];
    return {
      method,
      path,
      desc: description(capability),
      input,
      output,
      ...(scope !== undefined && { scope }),
      ...(expose !== undefined && { expose }),
    };
  };
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
  return { endpoints, capabilities, schemas, inputFor };
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
  const startOutput: ZodType = config.startOutput ?? config.id;
  const { endpoints, capabilities, schemas, inputFor } = buildCanonicalEndpointTable(
    config,
    startOutput,
  );
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
