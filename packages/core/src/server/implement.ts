import type { ZodType } from 'zod';
import type {
  ContractDef,
  EndpointDef,
  MultipartDescriptor,
  RuntimeContext,
} from '../contract';
import { mergeMeta } from '../contract/define';
import { callRuntimeHandler, typedEntries } from '../internal/typed';
import type {
  EndpointHandlerContext,
  Handlers,
  MethodDef,
  MultipartReceiver,
  ServiceDef,
  StreamingMultipartImplementation,
} from './types';

type StreamingEndpoint = EndpointDef & {
  multipart: MultipartDescriptor & { delivery: 'stream' };
};
type ReceiverMap<E extends StreamingEndpoint> = {
  [K in keyof E['multipart']['files']]: MultipartReceiver;
};
type ReceiverValue<R> = R extends MultipartReceiver<infer V> ? V : never;
type StreamedFiles<E extends StreamingEndpoint, R extends ReceiverMap<E>> = {
  [K in keyof E['multipart']['files']]: E['multipart']['files'][K] extends {
    multiple: true;
  }
    ? ReceiverValue<R[K]>[]
    : E['multipart']['files'][K] extends { required: false }
      ? ReceiverValue<R[K]> | undefined
      : ReceiverValue<R[K]>;
};
type StreamingReturn<E extends EndpointDef> = E extends { output: ZodType<infer O> }
  ? O | Promise<O>
  : void | Promise<void>;

function isStreamingImplementation(value: unknown): value is StreamingMultipartImplementation {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    value.kind === 'stitchkit.multipart.stream'
  );
}

/**
 * Bind streaming multipart receivers to one endpoint while inferring the
 * receiver values handed to its final handler.
 */
export function defineMultipartStream<
  const E extends StreamingEndpoint,
  const R extends ReceiverMap<E>,
>(
  endpoint: E,
  config: {
    files: R & Record<Exclude<keyof R, keyof E['multipart']['files']>, never>;
    handler: (
      ctx: EndpointHandlerContext<E, RuntimeContext> & { files: StreamedFiles<E, R> },
    ) => StreamingReturn<E>;
  },
): StreamingMultipartImplementation {
  const receivers: Record<string, MultipartReceiver> = {};
  for (const [key, receiver] of typedEntries(config.files)) {
    receivers[String(key)] = receiver;
  }
  const declared = Object.keys(endpoint.multipart.files);
  const configured = Object.keys(receivers);
  if (
    declared.length !== configured.length ||
    declared.some((field) => !Object.hasOwn(receivers, field))
  ) {
    throw new Error('Streaming multipart receivers must exactly match declared file fields');
  }

  return {
    kind: 'stitchkit.multipart.stream',
    receivers,
    execute(ctx, files) {
      return callRuntimeHandler(config.handler, { ...ctx, files });
    },
  };
}

/** Frozen so the same array cannot be mutated through one method and seen by another. */
const HTTP_ONLY = Object.freeze(['HTTP'] as const);

/**
 * Bind a contract to its typed `handlers`, producing a `ServiceDef` to mount on
 * `createServer`. Every handler is type-checked against its endpoint's schemas.
 * Pass `TCtx` for a typed handler context — or use `createImplement` to fix it
 * once.
 */
export function implement<
  T extends Record<string, EndpointDef>,
  TCtx extends RuntimeContext = RuntimeContext,
>(contract: ContractDef<T, string>, handlers: Handlers<T, TCtx>): ServiceDef {
  const methods: Record<string, MethodDef<unknown, unknown, unknown>> = {};

  // Effective scope of the whole contract — endpoints inherit it unless they
  // declare their own. Resolved once here so every `MethodDef.scope` and the
  // `ServiceDef.scope` share a single source of truth.
  const groupScope = contract.meta.scope ?? 'public';

  for (const [key, endpoint] of typedEntries(contract.endpoints)) {
    const typedHandler = handlers[key];
    const isStreaming = endpoint.multipart?.delivery === 'stream';
    if (!isStreaming && typeof typedHandler !== 'function') {
      throw new Error(
        `[stitchkit] implement: missing handler for "${contract.meta.prefix}.${String(key)}"`,
      );
    }
    if (isStreaming && !isStreamingImplementation(typedHandler)) {
      throw new Error(
        `[stitchkit] implement: streaming multipart endpoint "${contract.meta.prefix}.${String(key)}" must use defineMultipartStream()`,
      );
    }

    const streamingHandler = isStreamingImplementation(typedHandler)
      ? typedHandler
      : undefined;
    const regularHandler = typeof typedHandler === 'function' ? typedHandler : undefined;

    methods[String(key)] = {
      method: endpoint.method,
      path: endpoint.path,
      desc: endpoint.desc,
      // Stable (service, action) identity for hooks / audit (→ ADR 0022).
      serviceName: contract.meta.prefix,
      key: String(key),
      toolName: 'toolName' in endpoint ? endpoint.toolName : undefined,
      // A raw endpoint's exposure is forced, not inherited: with `expose`
      // undefined the framework's own default convention reads "MCP + AGENT on",
      // so every pre-existing exposure reader — audit scripts, a bring-your-own
      // transport — would conclude a download is a tool. Making it explicit keeps
      // them correct without teaching them about `raw`. → ADR 0038.
      expose:
        endpoint.rawResponse || endpoint.rawBody || endpoint.responseMeta
          ? HTTP_ONLY
          : endpoint.expose,
      // Effective scope: per-endpoint override, else the contract group scope.
      // Always populated so `beforeHandle(ctx, endpoint)` can scope-gate from
      // `endpoint.scope` alone — no consumer ever re-resolves against a service.
      scope: endpoint.scope ?? groupScope,
      paramsSchema: endpoint.params,
      inputSchema: endpoint.input,
      outputSchema: endpoint.output,
      multipart: endpoint.multipart,
      multipartReceivers: streamingHandler?.receivers,
      maxJsonBodyBytes: endpoint.maxJsonBodyBytes,
      // Transport-neutral retry/replay hint — rides through untouched (→ ADR 0027).
      idempotent: endpoint.idempotent,
      ui: 'ui' in endpoint ? endpoint.ui : undefined,
      annotations: 'annotations' in endpoint ? endpoint.annotations : undefined,
      mcp: 'mcp' in endpoint ? endpoint.mcp : undefined,
      // Opaque app metadata — the contract-wide default shallow-merged with the
      // endpoint's, endpoint keys winning. Undefined on both sides stays
      // undefined: readers test `method.meta?.x`. → ADR 0021 / 0036.
      meta: mergeMeta(contract.meta.meta, endpoint.meta),
      // The handler owns the response — skip output validation, serialization
      // and every tool surface. → ADR 0038.
      rawResponse: endpoint.rawResponse,
      rawBody: endpoint.rawBody,
      responseMeta: endpoint.responseMeta,
      contentType: 'contentType' in endpoint ? endpoint.contentType : undefined,
      handler: streamingHandler
        ? (ctx: RuntimeContext) => streamingHandler.execute(ctx, ctx.files ?? {})
        : (ctx: RuntimeContext) => {
            if (!regularHandler) {
              throw new Error(
                `[stitchkit] implement: missing handler for "${contract.meta.prefix}.${String(key)}"`,
              );
            }
            return callRuntimeHandler(regularHandler, ctx);
          },
    };
  }

  return {
    name: contract.meta.prefix,
    prefix: contract.meta.prefix,
    scope: groupScope,
    methods,
  };
}

/**
 * Fix the handler context type once — `const implement =
 * createImplement<MyContext>()` — so each `implement()` call site stays free of
 * the generic. The application declares its context shape in a single place.
 */
export function createImplement<TCtx extends RuntimeContext>() {
  return <T extends Record<string, EndpointDef>>(
    contract: ContractDef<T, string>,
    handlers: Handlers<T, TCtx>,
  ): ServiceDef => implement(contract, handlers);
}
