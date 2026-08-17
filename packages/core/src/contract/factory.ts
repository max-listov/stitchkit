/**
 * A `defineContract` bound to an application's scope vocabulary — so every
 * contract MUST declare a `scope`, typed to that union.
 *
 * Plain `defineContract` defaults a missing `scope` to `'public'` (fail-open):
 * forget it and the endpoint is public. A project that gates everything writes
 * a thin wrapper to make `scope` required and typed — the same 30-line wrapper
 * in every repo. `createContractFactory` is that wrapper, once:
 *
 * ```ts
 * // app: one line
 * const { defineContract } = createContractFactory<'public' | 'user' | 'admin'>();
 *
 * // scope is now REQUIRED and checked against the union — a typo or a missing
 * // scope is a compile error, not a silent public endpoint.
 * export const users = defineContract({ prefix: 'users', scope: 'user' }, { … });
 * ```
 *
 * The scope vocabulary comes from the app; the core stays domain-free (ADR 0002).
 * The returned contracts are ordinary `ContractDef`s — `implement`, `createClient`
 * and the tool mounts treat them exactly as before.
 */

import { mapObjectTypeBoundary } from '../internal/typed';
import type { ContractDef, ContractMeta, EndpointDef, Transport } from './define';
import { defineContract } from './define';

export type ContractFactoryToolExposure = 'explicit';

export interface ContractFactoryConfig {
  /** Missing endpoint `expose` becomes HTTP-only; every tool surface is opt-in. */
  toolExposure: ContractFactoryToolExposure;
}

export type ExplicitToolExposureEndpoints<T extends Record<string, EndpointDef>> = {
  [K in keyof T]: T[K] extends { expose: readonly Transport[] }
    ? T[K]
    : T[K] & { expose: readonly ['HTTP'] };
};

/** A factory-defined contract whose concrete scope remains required in metadata. */
export interface ScopedContractDef<
  T extends Record<string, EndpointDef> = Record<string, EndpointDef>,
  TScope extends string = string,
> extends ContractDef<T, TScope> {
  meta: ContractMeta<TScope> & { scope: TScope };
}

/**
 * An endpoint authored through the factory: the per-endpoint `scope` override is
 * held to the same union as the contract's.
 *
 * Constraining the type parameter (rather than intersecting the argument) keeps
 * `T` itself unchanged, so `ExplicitToolExposureEndpoints<T>` and the boundary
 * mapping below still see the endpoints the caller wrote. The check is
 * structural, so it also covers `HeadEndpointDef`, which declares its own
 * `scope` outside `EndpointDefBase`.
 */
export type FactoryScopedEndpoint<TScope extends string> = EndpointDef & {
  scope?: TScope;
};

/** A `defineContract` whose `scope` is required and typed to `TScope`. */
export type ScopedDefineContract<TScope extends string> = <
  const TContractScope extends TScope,
  const T extends Record<string, FactoryScopedEndpoint<TScope>>,
>(
  meta: { prefix: string; scope: TContractScope; meta?: Record<string, unknown> },
  endpoints: T,
) => ScopedContractDef<T, TContractScope>;

/** Scoped contract authoring where every omitted exposure becomes HTTP-only. */
export type ExplicitScopedDefineContract<TScope extends string> = <
  const TContractScope extends TScope,
  const T extends Record<string, FactoryScopedEndpoint<TScope>>,
>(
  meta: { prefix: string; scope: TContractScope; meta?: Record<string, unknown> },
  endpoints: T,
) => ScopedContractDef<ExplicitToolExposureEndpoints<T>, TContractScope>;

/**
 * Build a `defineContract` that requires a `scope` from the application's own
 * union. Call once per app and re-export the returned `defineContract`.
 */
export function createContractFactory<TScope extends string>(): {
  defineContract: ScopedDefineContract<TScope>;
};
export function createContractFactory<TScope extends string>(
  config: ContractFactoryConfig,
): {
  defineContract: ExplicitScopedDefineContract<TScope>;
};
export function createContractFactory<TScope extends string>(
  config?: ContractFactoryConfig,
):
  | { defineContract: ScopedDefineContract<TScope> }
  | { defineContract: ExplicitScopedDefineContract<TScope> } {
  const scoped: ScopedDefineContract<TScope> = (meta, endpoints) => {
    // Run the real `defineContract` for its validation (duplicate toolName,
    // empty desc), then return with the app's scope typed — its overloads
    // would otherwise resolve to the default `'public'` scope. No cast: the
    // result is rebuilt from the validated endpoints + the given scope.
    const validated = defineContract({ prefix: meta.prefix }, endpoints);
    return {
      endpoints: validated.endpoints,
      // Every field of the given meta is forwarded — rebuilding it by hand
      // silently dropped anything added to `ContractMeta` (a contract-level
      // `meta` default would never reach an endpoint). → ADR 0036.
      meta: { ...meta, prefix: meta.prefix, scope: meta.scope },
    };
  };

  if (config?.toolExposure !== 'explicit') return { defineContract: scoped };

  const explicit: ExplicitScopedDefineContract<TScope> = (meta, endpoints) => {
    const materialized = mapObjectTypeBoundary<
      typeof endpoints,
      ExplicitToolExposureEndpoints<typeof endpoints>
    >(endpoints, (_key, endpoint) =>
      endpoint.expose ? endpoint : { ...endpoint, expose: ['HTTP'] },
    );
    return scoped(meta, materialized);
  };

  return { defineContract: explicit };
}
