/**
 * The per-capability tools of a runtime-only async operation. Every follow-up
 * capability goes through the same `inspect` step — authorize, read, classify —
 * so one surface object carries it and each builder only adds what its
 * capability does with the result.
 */
import type { ZodObject, ZodType, z } from 'zod';
import type {
  EndpointToolAnnotations,
  HttpMethod,
  ToolTransport,
} from '../../contract/define';
import { AppError } from '../../contract/errors';
import {
  defineRuntimeTool,
  type RuntimeToolDefinition,
  type RuntimeToolHandlerContext,
  type RuntimeToolIdentity,
} from '../runtime-tool';
import {
  AsyncOperationCancelResultSchema,
  type AsyncOperationCapability,
} from './async-operation-contract';
import type {
  AsyncOperationCancelCapability,
  AsyncOperationOutputCapability,
  RuntimeAsyncOperationConfig,
} from './async-operation-runtime-types';
import { defineWaitTool } from './define-wait-tool';

type FollowCapability = Exclude<AsyncOperationCapability, 'start'>;

/** The config fields every capability reads; `start` and the optional capabilities stay out. */
export type RuntimeOperationSurfaceConfig<
  TId extends ZodObject,
  TState extends ZodType,
  TSnapshot extends ZodType,
> = Pick<
  RuntimeAsyncOperationConfig<ZodObject, TId, TState, TSnapshot>,
  | 'name'
  | 'description'
  | 'identity'
  | 'id'
  | 'state'
  | 'snapshot'
  | 'authorize'
  | 'inspect'
  | 'classify'
  | 'names'
  | 'descriptions'
  | 'scopes'
  | 'annotations'
  | 'transports'
  | 'backoff'
  | 'defaultTimeout'
  | 'timeoutFromId'
>;

export interface RuntimeOperationCommon {
  name: string;
  description: string;
  transports: readonly ToolTransport[] | undefined;
  annotations: EndpointToolAnnotations | undefined;
}

export interface RuntimeOperationSurface<
  TId extends ZodObject,
  TState extends ZodType,
  TSnapshot extends ZodType,
> {
  config: RuntimeOperationSurfaceConfig<TId, TState, TSnapshot>;
  common: (capability: AsyncOperationCapability) => RuntimeOperationCommon;
  identity: (capability: AsyncOperationCapability, method: HttpMethod) => RuntimeToolIdentity;
  inspect: (
    capability: FollowCapability,
    context: RuntimeToolHandlerContext<TId>,
  ) => Promise<{ state: z.output<TState>; snapshot: z.output<TSnapshot> }>;
}

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

export function createRuntimeOperationSurface<
  TId extends ZodObject,
  TState extends ZodType,
  TSnapshot extends ZodType,
>(
  config: RuntimeOperationSurfaceConfig<TId, TState, TSnapshot>,
): RuntimeOperationSurface<TId, TState, TSnapshot> {
  const capabilityName = (capability: AsyncOperationCapability): string =>
    config.names?.[capability] ?? `${config.name}_${capability}`;
  const description = (capability: AsyncOperationCapability): string =>
    config.descriptions?.[capability] ?? `${config.description}: ${capability}`;
  return {
    config,
    identity: (capability, method) => ({
      serviceName: config.identity.serviceName,
      action: `${config.identity.action}.${capability}`,
      scope: config.scopes?.[capability] ?? config.identity.scope,
      meta: config.identity.meta,
      method,
    }),
    common: (capability) => ({
      name: capabilityName(capability),
      description: description(capability),
      transports: config.transports?.[capability],
      annotations:
        config.annotations?.[capability] ??
        (capability === 'start' || capability === 'cancel'
          ? { destructiveHint: true }
          : undefined),
    }),
    inspect: async (capability, context) => {
      await config.authorize(context.input, capability, context);
      const state = config.state.parse(await config.inspect(context.input, context));
      const snapshot = config.snapshot.parse(await config.classify(state, context));
      return { state, snapshot };
    },
  };
}

/** `status` answers once; `wait` polls the same inspection until a terminal phase. */
export function defineObservationTools<
  TId extends ZodObject,
  TState extends ZodType,
  TSnapshot extends ZodType,
>(
  surface: RuntimeOperationSurface<TId, TState, TSnapshot>,
): { status: RuntimeToolDefinition; wait: RuntimeToolDefinition } {
  const { config } = surface;
  const status = defineRuntimeTool({
    ...surface.common('status'),
    identity: surface.identity('status', 'GET'),
    input: config.id,
    output: config.snapshot,
    handler: async (context) => (await surface.inspect('status', context)).snapshot,
  });
  const wait = defineWaitTool({
    ...surface.common('wait'),
    identity: surface.identity('wait', 'GET'),
    input: config.id,
    state: config.snapshot,
    poll: async (_id, context) => (await surface.inspect('wait', context)).snapshot,
    done: terminal,
    backoff: config.backoff,
    defaultTimeout: config.defaultTimeout,
    timeoutFromInput: config.timeoutFromId,
  });
  return { status, wait };
}

export function defineCancelTool<
  TId extends ZodObject,
  TState extends ZodType,
  TSnapshot extends ZodType,
>(
  surface: RuntimeOperationSurface<TId, TState, TSnapshot>,
  capability: AsyncOperationCancelCapability<TId, TState>,
): RuntimeToolDefinition {
  return defineRuntimeTool({
    ...surface.common('cancel'),
    identity: surface.identity('cancel', 'DELETE'),
    input: surface.config.id,
    output: AsyncOperationCancelResultSchema,
    handler: async (context) => {
      const inspected = await surface.inspect('cancel', context);
      return capability.handler(inspected.state, context);
    },
  });
}

/** `result` and `artifacts` differ only in name and message: both exist only after success. */
export function defineSucceededOutputTool<
  TId extends ZodObject,
  TState extends ZodType,
  TSnapshot extends ZodType,
>(
  surface: RuntimeOperationSurface<TId, TState, TSnapshot>,
  kind: 'result' | 'artifacts',
  capability: AsyncOperationOutputCapability<TId, TState, ZodType>,
  unavailableMessage: string,
): RuntimeToolDefinition {
  return defineRuntimeTool({
    ...surface.common(kind),
    identity: surface.identity(kind, 'GET'),
    input: surface.config.id,
    output: capability.output,
    handler: async (context) => {
      const inspected = await surface.inspect(kind, context);
      if (!succeeded(inspected.snapshot)) {
        throw new AppError('OPERATION_NOT_SUCCEEDED', unavailableMessage, 409);
      }
      return capability.handler(inspected.state, context);
    },
  });
}
