import type { ZodType } from 'zod';
import type { MultipartDescriptor } from '../contract/client-types';
import type { ContractDef, EndpointDef } from '../contract/define';
import { AppError } from '../contract/errors';
import type { RuntimeContext } from '../contract/runtime-context';
import { callRuntimeHandler, typedEntries } from '../internal/typed';
import { contractMethodFields } from './contract-method';
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

/**
 * Bind a contract to its typed `handlers`, producing a `ServiceDef` to mount on
 * `createServer`. Every handler is type-checked against its endpoint's schemas.
 * Pass `TCtx` for a typed handler context — or use `createImplement` to fix it
 * once.
 */
/**
 * What to do when a contract endpoint has no handler.
 *
 * `'throw'` — the default, and the right answer in production: a contract
 * without its handler is a lie about the surface, and a client sees an endpoint
 * that is not there.
 *
 * `'stub'` — mount a refusal instead and keep the application up. This exists
 * for one measured situation: a dev stand under a file watcher. Adding an
 * endpoint is two edits by construction — the contract and the handler — and an
 * editor saves one file at a time, so the watcher restarts on the first one.
 * Between the two saves the whole stand is down, for everyone using it. A rule
 * ("make both edits at once") cannot outrun the filesystem; this can.
 */
export type MissingHandlerPolicy = 'throw' | 'stub';

/** How a registry or contract binding treats an unimplemented endpoint. */
export interface ImplementOptions {
  /** Default `'throw'`. `'stub'` refuses the call instead of refusing to start. */
  onMissingHandler?: MissingHandlerPolicy;
}

/**
 * The refusal a stubbed endpoint answers with.
 *
 * `501` is the honest status, and `NOT_IMPLEMENTED` is registered in
 * `STITCH_ERROR_STATUS` — a breaking addition by this repository's own precedent
 * (an `exhaustive` error vocabulary must name it), chosen deliberately over the
 * quieter option: the framework must not throw a code its own registry does not
 * know, or the code travels in stitchkit's spelling past every consumer
 * `codeMap`. A gate holds that invariant and refused the unregistered code.
 * Registered, it survives a process hop as 501 too.
 */
function stubHandler(label: string): () => never {
  return () => {
    throw new AppError(
      'NOT_IMPLEMENTED',
      `[stitchkit] ${label} is declared by its contract and has no handler`,
      501,
    );
  };
}

export function bindContract(
  contract: ContractDef,
  handlers: Record<string, unknown>,
  options?: ImplementOptions,
): ServiceDef {
  const methods: Record<string, MethodDef<unknown, unknown, unknown>> = {};

  // Effective scope of the whole contract — endpoints inherit it unless they
  // declare their own. Resolved once here so every `MethodDef.scope` and the
  // `ServiceDef.scope` share a single source of truth.
  const groupScope = contract.meta.scope ?? 'public';

  for (const [key, endpoint] of typedEntries(contract.endpoints)) {
    const label = `${contract.meta.prefix}.${String(key)}`;
    let typedHandler = handlers[String(key)];
    const isStreaming = endpoint.multipart?.delivery === 'stream';
    if (!isStreaming && typeof typedHandler !== 'function') {
      // A streaming endpoint is deliberately never stubbed: it needs
      // `defineMultipartStream()` receivers, and a stub that answers with a
      // refusal instead of a stream would be a different shape wearing the same
      // name. The stand still stops on one, and that is stated in the guide.
      if (options?.onMissingHandler !== 'stub') {
        throw new Error(`[stitchkit] implement: missing handler for "${label}"`);
      }
      console.warn(
        `[stitchkit] implement: "${label}" has no handler and is mounted as a 501 stub`,
      );
      typedHandler = stubHandler(label);
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
      ...contractMethodFields(contract, String(key), endpoint),
      multipartReceivers: streamingHandler?.receivers,
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
>(
  contract: ContractDef<T, string>,
  handlers: Handlers<T, TCtx>,
  options?: ImplementOptions,
): ServiceDef {
  return bindContract(contract, handlers, options);
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
    options?: ImplementOptions,
  ): ServiceDef => implement(contract, handlers, options);
}

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
    options?: ImplementOptions,
  ): ServiceDef => bindContract(contract, handlers, options);

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
