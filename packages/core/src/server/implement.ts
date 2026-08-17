import type { ZodType } from 'zod';
import type {
  ContractDef,
  EndpointDef,
  MultipartDescriptor,
  RuntimeContext,
} from '../contract';
import { mergeMeta } from '../contract/define';
import {
  callRuntimeHandler,
  isRecord,
  transportResult,
  typedEntries,
} from '../internal/typed';
import type {
  EndpointHandlerContext,
  Handlers,
  MethodDef,
  MultipartReceiver,
  ScopeContexts,
  ScopedHandlers,
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
 * Receivers plus the final handler for one streaming multipart endpoint. `TCtx`
 * is the handler context: `RuntimeContext` by default, an application context
 * through `createMultipartStream`, a scope's context through
 * `createScopedImplement(...).stream`.
 */
export interface MultipartStreamConfig<
  E extends StreamingEndpoint,
  R extends ReceiverMap<E>,
  TCtx extends RuntimeContext,
> {
  files: R & Record<Exclude<keyof R, keyof E['multipart']['files']>, never>;
  handler: (
    ctx: EndpointHandlerContext<E, TCtx> & { files: StreamedFiles<E, R> },
  ) => StreamingReturn<E>;
}

/**
 * Bind streaming multipart receivers to one endpoint while inferring the
 * receiver values handed to its final handler.
 *
 * The handler context is the loose `RuntimeContext`. To read fields the
 * application injects, build the implementation through
 * `createMultipartStream<Ctx>()` or, in a scoped app,
 * `createScopedImplement<Scopes>().stream(scope, …)`.
 */
export function defineMultipartStream<
  const E extends StreamingEndpoint,
  const R extends ReceiverMap<E>,
>(
  endpoint: E,
  config: MultipartStreamConfig<E, R, RuntimeContext>,
): StreamingMultipartImplementation {
  return buildMultipartStream(endpoint, config.files, config.handler);
}

/**
 * The runtime half, shared by every typed entry point. The handler arrives as
 * `unknown` because each entry point has already type-checked it against its own
 * context; the runtime only ever hands it a context object, so widening here
 * costs no guarantee and keeps the typed wrappers free of casts (the context
 * types are contravariant, so one wrapper cannot delegate to another).
 */
function buildMultipartStream(
  endpoint: StreamingEndpoint,
  files: Record<string, MultipartReceiver>,
  handler: unknown,
): StreamingMultipartImplementation {
  const receivers: Record<string, MultipartReceiver> = {};
  for (const [key, receiver] of typedEntries(files)) {
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
    execute(ctx, streamedFiles) {
      return callRuntimeHandler(handler, { ...ctx, files: streamedFiles });
    },
  };
}

/**
 * Fix one handler context type for streaming multipart endpoints, the way
 * `createImplement` fixes it for ordinary handlers. Without this, a streaming
 * handler only ever sees the loose `RuntimeContext`.
 */
export function createMultipartStream<TCtx extends RuntimeContext>() {
  return <const E extends StreamingEndpoint, const R extends ReceiverMap<E>>(
    endpoint: E,
    config: MultipartStreamConfig<E, R, TCtx>,
  ): StreamingMultipartImplementation =>
    buildMultipartStream(endpoint, config.files, config.handler);
}

function isStreamingEndpoint(endpoint: EndpointDef): endpoint is StreamingEndpoint {
  return endpoint.multipart?.delivery === 'stream';
}

/**
 * A `ServiceDef` whose handlers only throw — enough for everything that reads
 * the mounted surface (names, exposure, kinds) without implementing anything.
 *
 * Internal on purpose (not re-exported from an entrypoint): a listing helper.
 * Going through the real `bindContract` is the point — the produced methods are
 * the same objects the real mounts see, so a name listing derived from here can
 * never drift from the mounted surface.
 */
export function contractOnlyService(contract: ContractDef): ServiceDef {
  const handlers: Record<string, unknown> = {};
  for (const [key, endpoint] of Object.entries(contract.endpoints)) {
    if (isStreamingEndpoint(endpoint)) {
      const receivers: Record<string, MultipartReceiver> = {};
      for (const field of Object.keys(endpoint.multipart.files)) {
        receivers[field] = () => {
          throw new Error('[stitchkit] contract-only service: handlers are not callable');
        };
      }
      const streaming: StreamingMultipartImplementation = {
        kind: 'stitchkit.multipart.stream',
        receivers,
        execute: () => {
          throw new Error('[stitchkit] contract-only service: handlers are not callable');
        },
      };
      handlers[key] = streaming;
      continue;
    }
    handlers[key] = () => {
      throw new Error('[stitchkit] contract-only service: handlers are not callable');
    };
  }
  return bindContract(contract, handlers);
}

/** Frozen so the same array cannot be mutated through one method and seen by another. */
const HTTP_ONLY = Object.freeze(['HTTP'] as const);

/**
 * Bind a contract to its typed `handlers`, producing a `ServiceDef` to mount on
 * `createServer`. Every handler is type-checked against its endpoint's schemas.
 * Pass `TCtx` for a typed handler context — or use `createImplement` to fix it
 * once.
 */
function bindContract(contract: ContractDef, handlers: Record<string, unknown>): ServiceDef {
  const methods: Record<string, MethodDef<unknown, unknown, unknown>> = {};

  // Effective scope of the whole contract — endpoints inherit it unless they
  // declare their own. Resolved once here so every `MethodDef.scope` and the
  // `ServiceDef.scope` share a single source of truth.
  const groupScope = contract.meta.scope ?? 'public';

  for (const [key, endpoint] of typedEntries(contract.endpoints)) {
    const typedHandler = handlers[String(key)];
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

export function implement<
  T extends Record<string, EndpointDef>,
  TCtx extends RuntimeContext = RuntimeContext,
>(contract: ContractDef<T, string>, handlers: Handlers<T, TCtx>): ServiceDef {
  return bindContract(contract, handlers);
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

/**
 * Fix one scope→context map for the application, then implement every contract
 * with it — each handler typed by its endpoint's **effective** scope rather than
 * by a superset that promises fields the runtime never injects into a
 * `public` call.
 *
 * ```ts
 * const implementFor = createScopedImplement<{
 *   public: object
 *   user: { userId: string }
 *   admin: { userId: string; isAdmin: true }
 * }>()
 *
 * implementFor(usersContract, { … })  // ctx typed per endpoint scope
 * ```
 *
 * The map is type-only — scope fields are types, and a runtime map would force
 * `{} as UserFields` at the call site. A contract with no `scope` is `'public'`
 * (→ `defineContract`), so `'public'` must be a key of the map.
 *
 * The map states what the application's `beforeHandle` / `createAuthHook.inject`
 * puts in the context. The framework does not verify it — a scope whose fields
 * are never injected still type-checks. → ADR 0075.
 */
export function createScopedImplement<TScopes extends ScopeContexts>() {
  const implementScoped = <
    const T extends Record<string, EndpointDef>,
    TContractScope extends Extract<keyof TScopes, string>,
  >(
    contract: ContractDef<T, TContractScope>,
    handlers: ScopedHandlers<T, TContractScope, TScopes>,
  ): ServiceDef => bindContract(contract, handlers);

  /**
   * A streaming multipart implementation typed to one scope's context.
   *
   * The scope is written at the call site, but it is not free: it must be the
   * scope THIS endpoint declares. An endpoint that declares none (or only
   * optionally) is rejected — its effective scope comes from the contract, which
   * this builder cannot see, and guessing it would rebuild the very superset
   * this factory removes. Declare the scope on the endpoint, or use
   * `createMultipartStream<Ctx>()` for an application-wide context.
   */
  const stream = <const E extends StreamingEndpoint, const R extends ReceiverMap<E>>(
    scope: StreamScope<E, TScopes>,
    endpoint: E,
    config: MultipartStreamConfig<
      E,
      R,
      RuntimeContext & TScopes[StreamScope<E, TScopes> & keyof TScopes]
    >,
  ): StreamingMultipartImplementation => {
    // The type already pins `scope` to the endpoint's own when it declares one.
    // Repeated at runtime so a JavaScript caller cannot type a handler against a
    // scope the endpoint never runs under.
    if (endpoint.scope !== undefined && endpoint.scope !== scope) {
      throw new Error(
        `[stitchkit] createScopedImplement.stream: endpoint declares scope "${endpoint.scope}" but "${String(scope)}" was given`,
      );
    }
    return buildMultipartStream(endpoint, config.files, config.handler);
  };

  /**
   * Contextually type one contract's handlers WITHOUT binding them — for the
   * registry path, where binding happens once in
   * `createScopedImplementRegistry` and the service file only declares.
   *
   * Curried out of necessity, not style: a single call cannot both take the
   * contract and contextually infer the handlers from it. The extra-key
   * validator keeps a stray handler an error at the declaration, where the
   * author is, instead of at the faraway registry bind.
   */
  const declare =
    <
      const T extends Record<string, EndpointDef>,
      TContractScope extends Extract<keyof TScopes, string>,
    >(
      _contract: ContractDef<T, TContractScope>,
    ) =>
    <const THandlers extends ScopedHandlers<T, TContractScope, TScopes>>(
      handlers: THandlers & Record<Exclude<keyof THandlers, keyof T>, never>,
    ): THandlers =>
      handlers;

  return Object.assign(implementScoped, { stream, declare });
}

/** A contract registry whose every group scope is a key of the scope map. */
export type ScopedImplementationRegistry<TScopes extends ScopeContexts> = Record<
  string,
  ContractDef<Record<string, EndpointDef>, Extract<keyof TScopes, string>>
>;

/**
 * The scope `createScopedImplement(...).stream` accepts for one endpoint: the
 * literal the endpoint declares, or a message explaining why it cannot be typed.
 */
export type StreamScope<
  E extends EndpointDef,
  TScopes extends ScopeContexts,
> = 'scope' extends keyof E
  ? undefined extends E['scope']
    ? 'stitchkit: .stream() needs the endpoint to declare its own scope'
    : Extract<E['scope'], string> extends infer S extends string
      ? [S] extends [Extract<keyof TScopes, string>]
        ? S
        : `stitchkit: scope "${S}" is not declared in createScopedImplement`
      : 'stitchkit: .stream() needs the endpoint to declare its own scope'
  : 'stitchkit: .stream() needs the endpoint to declare its own scope';

/** Exact scoped handlers map derived from a literal contract registry. */
export type ScopedRegistryHandlers<
  TContracts extends ImplementationRegistry,
  TScopes extends ScopeContexts,
> = {
  [K in keyof TContracts]: TContracts[K] extends ContractDef<
    infer TEndpoints,
    infer TContractScope extends string
  >
    ? ScopedHandlers<TEndpoints, TContractScope, TScopes>
    : never;
};

export type ExactScopedRegistryHandlers<
  TContracts extends ImplementationRegistry,
  THandlers extends ScopedRegistryHandlers<TContracts, TScopes>,
  TScopes extends ScopeContexts,
> = THandlers &
  ScopedRegistryHandlers<TContracts, TScopes> &
  Record<Exclude<keyof THandlers, keyof TContracts>, never> & {
    [K in keyof THandlers & keyof TContracts]: THandlers[K] &
      Record<
        Exclude<keyof THandlers[K], keyof ScopedRegistryHandlers<TContracts, TScopes>[K]>,
        never
      >;
  };

/**
 * The registry form of {@link createScopedImplement} — one literal contract
 * registry bound to one handler registry, with every handler still typed by its
 * endpoint's effective scope. Missing, extra and endpoint-incompatible entries
 * fail exactly as they do in `implementRegistry`.
 */
export function createScopedImplementRegistry<TScopes extends ScopeContexts>() {
  return <
    // Group scopes are constrained on the CONTRACTS parameter, mirroring the
    // single-contract form. Putting the check inside the handlers mapped type
    // would wrap each handler in a conditional and defeat contextual typing of
    // an unannotated `ctx`.
    const TContracts extends ScopedImplementationRegistry<TScopes>,
    const THandlers extends ScopedRegistryHandlers<TContracts, TScopes>,
  >(
    contracts: TContracts,
    handlers: ExactScopedRegistryHandlers<TContracts, THandlers, TScopes>,
  ): KeyedServices<TContracts> =>
    // Same boundary as `implementRegistry` — see the comment there.
    transportResult<KeyedServices<TContracts>>(bindRegistry(contracts, handlers));
}

type ImplementationContract = ContractDef<Record<string, EndpointDef>, string>;
export type ImplementationRegistry = Record<
  string,
  ContractDef<Record<string, EndpointDef>, string>
>;

function isImplementationContract(value: unknown): value is ImplementationContract {
  return (
    isRecord(value) &&
    isRecord(value.meta) &&
    typeof value.meta.prefix === 'string' &&
    isRecord(value.endpoints)
  );
}

/** Exact handlers map derived from a literal contract registry. */
export type RegistryHandlers<
  TContracts extends ImplementationRegistry,
  TCtx extends RuntimeContext = RuntimeContext,
> = {
  [K in keyof TContracts]: TContracts[K] extends ContractDef<infer TEndpoints, string>
    ? Handlers<TEndpoints, TCtx>
    : never;
};

export type ExactRegistryHandlers<
  TContracts extends ImplementationRegistry,
  THandlers extends RegistryHandlers<TContracts, TCtx>,
  TCtx extends RuntimeContext,
> = THandlers &
  RegistryHandlers<TContracts, TCtx> &
  Record<Exclude<keyof THandlers, keyof TContracts>, never> & {
    [K in keyof THandlers & keyof TContracts]: THandlers[K] &
      Record<Exclude<keyof THandlers[K], keyof RegistryHandlers<TContracts, TCtx>[K]>, never>;
  };

/**
 * Registry results keep both shapes: the mount-ordered array a server consumes,
 * and the same services by their registry key. Keys are load-bearing for
 * consumers that filter a tool surface per caller ("these bots see only
 * services X and Y") — dropping them forced a hand-rebuilt prefix lookup, and a
 * silent one at that.
 */
export type KeyedServices<TContracts extends ImplementationRegistry> = ServiceDef[] & {
  /**
   * The same services, by registry key. Same objects as the array entries.
   * Non-enumerable: `Object.keys` / `Object.values` / object spread of the
   * array see only the services, exactly as before.
   */
  readonly byKey: { readonly [K in keyof TContracts]: ServiceDef };
};

function bindRegistry(
  contracts: ImplementationRegistry,
  handlers: Record<string, unknown>,
): ServiceDef[] & { byKey: Record<string, ServiceDef> } {
  const contractKeys = Object.keys(contracts);
  const handlerKeys = Object.keys(handlers);
  const missing = contractKeys.filter((key) => !Object.hasOwn(handlers, key));
  const extra = handlerKeys.filter((key) => !Object.hasOwn(contracts, key));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `[stitchkit] implementRegistry: registry mismatch (missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'})`,
    );
  }

  const prefixes = new Map<string, string>();
  const services: ServiceDef[] = [];
  const byKey: Record<string, ServiceDef> = {};
  for (const [key, candidate] of Object.entries(contracts)) {
    if (!isImplementationContract(candidate)) {
      throw new TypeError(
        `[stitchkit] implementRegistry: registry entry "${key}" must be one contract; composed arrays and namespaces are not supported`,
      );
    }
    const contract = candidate;
    // Duplicate detection keys on (scope, prefix), not prefix alone: the same
    // prefix under two different group scopes is a legal, mounted-in-production
    // shape — `scopePrefixes` separates their URLs, and a genuine path clash is
    // caught by the router per colliding route. Only a same-scope duplicate is
    // a registry mistake worth failing first. NUL-joined so the composite key
    // cannot collide with a real scope or prefix — the same idiom as the tool
    // surface ids in `tools/list-names.ts`.
    const groupScope = contract.meta.scope ?? 'public';
    const identity = `${groupScope}\u0000${contract.meta.prefix}`;
    const previousKey = prefixes.get(identity);
    if (previousKey !== undefined) {
      throw new Error(
        `[stitchkit] implementRegistry: duplicate contract prefix "${contract.meta.prefix}" in scope "${groupScope}" at "${previousKey}" and "${key}"`,
      );
    }
    prefixes.set(identity, key);
    const entryHandlers = handlers[key];
    if (!isRecord(entryHandlers)) {
      throw new TypeError(
        `[stitchkit] implementRegistry: handlers for "${key}" must be an object`,
      );
    }
    const endpointKeys = Object.keys(contract.endpoints);
    const handlerEntryKeys = Object.keys(entryHandlers);
    const missingEndpoints = endpointKeys.filter(
      (endpointKey) => !Object.hasOwn(entryHandlers, endpointKey),
    );
    const extraEndpoints = handlerEntryKeys.filter(
      (endpointKey) => !Object.hasOwn(contract.endpoints, endpointKey),
    );
    if (missingEndpoints.length > 0 || extraEndpoints.length > 0) {
      throw new Error(
        `[stitchkit] implementRegistry: handlers for "${key}" mismatch (missing: ${missingEndpoints.join(', ') || 'none'}; extra: ${extraEndpoints.join(', ') || 'none'})`,
      );
    }
    const service = bindContract(contract, entryHandlers);
    services.push(service);
    byKey[key] = service;
  }
  // Non-enumerable on purpose: an existing caller iterating the ARRAY with
  // `Object.values` / `Object.keys` (a real consumer pattern) must not receive
  // a phantom extra entry. Loose→typed boundary (→ ADR 0003): the type system
  // cannot see a `defineProperty` attachment.
  Object.defineProperty(services, 'byKey', { value: byKey, enumerable: false });
  return transportResult<ServiceDef[] & { byKey: Record<string, ServiceDef> }>(services);
}

/**
 * Bind an exact `name → contract` registry to its exact handlers map. Missing,
 * extra and endpoint-incompatible implementations fail at compile time; loose
 * JavaScript callers receive the same checks at runtime.
 */
export function implementRegistry<
  const TContracts extends ImplementationRegistry,
  const THandlers extends RegistryHandlers<TContracts>,
>(
  contracts: TContracts,
  handlers: ExactRegistryHandlers<TContracts, THandlers, RuntimeContext>,
): KeyedServices<TContracts> {
  // Loose→typed boundary (→ ADR 0003): `bindRegistry` builds `byKey` from the
  // runtime keys of `contracts`, which are exactly `keyof TContracts` — the
  // generic mapped type just cannot see that through an index signature.
  return transportResult<KeyedServices<TContracts>>(bindRegistry(contracts, handlers));
}

/** Fix one handler context type for every entry in an implementation registry. */
export function createImplementRegistry<TCtx extends RuntimeContext>() {
  return <
    const TContracts extends ImplementationRegistry,
    const THandlers extends RegistryHandlers<TContracts, TCtx>,
  >(
    contracts: TContracts,
    handlers: ExactRegistryHandlers<TContracts, THandlers, TCtx>,
  ): KeyedServices<TContracts> =>
    // Same boundary as `implementRegistry` — see the comment there.
    transportResult<KeyedServices<TContracts>>(bindRegistry(contracts, handlers));
}
