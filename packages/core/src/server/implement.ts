import type { ContractDef, EndpointDef, RuntimeContext } from '../contract';
import { typedEntries } from '../internal/typed';
import type { Handlers, MethodDef, ServiceDef } from './types';

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

    methods[String(key)] = {
      method: endpoint.method,
      path: endpoint.path,
      desc: endpoint.desc,
      // Stable (service, action) identity for hooks / audit (→ ADR 0022).
      serviceName: contract.meta.prefix,
      key: String(key),
      toolName: 'toolName' in endpoint ? endpoint.toolName : undefined,
      expose: endpoint.expose,
      // Effective scope: per-endpoint override, else the contract group scope.
      // Always populated so `beforeHandle(ctx, endpoint)` can scope-gate from
      // `endpoint.scope` alone — no consumer ever re-resolves against a service.
      scope: endpoint.scope ?? groupScope,
      paramsSchema: endpoint.params,
      inputSchema: endpoint.input,
      outputSchema: endpoint.output,
      multipart: endpoint.multipart,
      maxUploadBytes: endpoint.maxUploadBytes,
      // Transport-neutral retry/replay hint — rides through untouched (→ ADR 0027).
      idempotent: endpoint.idempotent,
      ui: 'ui' in endpoint ? endpoint.ui : undefined,
      annotations: 'annotations' in endpoint ? endpoint.annotations : undefined,
      // Opaque app metadata — rides through untouched (on the shared base, so no
      // `in` guard). Readable in hooks / on tool mounts. → ADR 0021.
      meta: endpoint.meta,
      handler: (ctx: RuntimeContext) =>
        (typedHandler as (ctx: RuntimeContext) => unknown)(ctx),
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
