import type { ZodObject, ZodType } from 'zod';
import { assertUniqueToolName } from '../names';
import { defineRuntimeTool, type RuntimeToolDefinition } from '../runtime-tool';
import { AsyncOperationCancelResultSchema } from './async-operation-contract';
import {
  createRuntimeOperationSurface,
  defineCancelTool,
  defineObservationTools,
  defineSucceededOutputTool,
} from './async-operation-runtime-tools';
import type {
  AsyncOperationCancelCapability,
  AsyncOperationOutputCapability,
  RuntimeAsyncOperation,
  RuntimeAsyncOperationConfig,
} from './async-operation-runtime-types';

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
  const surface = createRuntimeOperationSurface(config);

  const start = defineRuntimeTool({
    ...surface.common('start'),
    identity: surface.identity('start', 'POST'),
    input: config.startInput,
    output: config.id,
    handler: (context) => config.start(context.input, context),
  });
  const { status, wait } = defineObservationTools(surface);

  const definitions: Record<string, RuntimeToolDefinition> = { start, status, wait };
  const names = new Set<string>();

  if (config.cancel) {
    definitions.cancel = defineCancelTool(surface, config.cancel);
  }
  if (config.result) {
    definitions.result = defineSucceededOutputTool(
      surface,
      'result',
      config.result,
      'Operation result is not available',
    );
  }
  if (config.artifacts) {
    definitions.artifacts = defineSucceededOutputTool(
      surface,
      'artifacts',
      config.artifacts,
      'Operation artifacts are not available',
    );
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
