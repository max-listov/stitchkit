import type { ContractDef, EndpointDef } from '../contract/define';
import type { RuntimeContext } from '../contract/runtime-context';
import { isRecord, transportResult } from '../internal/typed';
import { bindContract, type ImplementOptions } from './implement';
import type { Handlers, ScopeContexts, ScopedHandlers, ServiceDef } from './types';

/** A contract registry whose every group scope is a key of the scope map. */
export type ScopedImplementationRegistry<TScopes extends ScopeContexts> = Record<
  string,
  ContractDef<Record<string, EndpointDef>, Extract<keyof TScopes, string>>
>;

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
    options?: ImplementOptions,
  ): KeyedServices<TContracts> =>
    // Same boundary as `implementRegistry` — see the comment there.
    transportResult<KeyedServices<TContracts>>(bindRegistry(contracts, handlers, options));
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
  options?: ImplementOptions,
): ServiceDef[] & { byKey: Record<string, ServiceDef> } {
  const contractKeys = Object.keys(contracts);
  const handlerKeys = Object.keys(handlers);
  const missing = contractKeys.filter((key) => !Object.hasOwn(handlers, key));
  const extra = handlerKeys.filter((key) => !Object.hasOwn(contracts, key));
  if (missing.length > 0 || extra.length > 0) {
    // The watcher case is symmetric and the fix has to be too. Saving the
    // contract first leaves a contract with no handlers (`missing`); saving the
    // handlers first leaves handlers with no contract (`extra`). A policy that
    // only understood the first would take the stand down on every other edit.
    if (options?.onMissingHandler !== 'stub') {
      throw new Error(
        `[stitchkit] implementRegistry: registry mismatch (missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'})`,
      );
    }
    console.warn(
      `[stitchkit] implementRegistry: registry mismatch (missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'}) — missing contracts are mounted as 501 stubs and extra handlers are ignored`,
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
    // A contract with no handlers object at all: every one of its endpoints
    // becomes a stub below, rather than the whole application refusing to start.
    const entryHandlers =
      handlers[key] === undefined && options?.onMissingHandler === 'stub' ? {} : handlers[key];
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
      const detail = `handlers for "${key}" mismatch (missing: ${missingEndpoints.join(', ') || 'none'}; extra: ${extraEndpoints.join(', ') || 'none'})`;
      if (options?.onMissingHandler !== 'stub') {
        throw new Error(`[stitchkit] implementRegistry: ${detail}`);
      }
      console.warn(
        `[stitchkit] implementRegistry: ${detail} — missing endpoints are mounted as 501 stubs and extra handlers are ignored`,
      );
    }
    const service = bindContract(contract, entryHandlers, options);
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
  options?: ImplementOptions,
): KeyedServices<TContracts> {
  // Loose→typed boundary (→ ADR 0003): `bindRegistry` builds `byKey` from the
  // runtime keys of `contracts`, which are exactly `keyof TContracts` — the
  // generic mapped type just cannot see that through an index signature.
  return transportResult<KeyedServices<TContracts>>(
    bindRegistry(contracts, handlers, options),
  );
}

/** Fix one handler context type for every entry in an implementation registry. */
export function createImplementRegistry<TCtx extends RuntimeContext>() {
  return <
    const TContracts extends ImplementationRegistry,
    const THandlers extends RegistryHandlers<TContracts, TCtx>,
  >(
    contracts: TContracts,
    handlers: ExactRegistryHandlers<TContracts, THandlers, TCtx>,
    options?: ImplementOptions,
  ): KeyedServices<TContracts> =>
    // Same boundary as `implementRegistry` — see the comment there.
    transportResult<KeyedServices<TContracts>>(bindRegistry(contracts, handlers, options));
}
