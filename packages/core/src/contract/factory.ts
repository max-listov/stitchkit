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

import { z } from 'zod';
import { mapObjectTypeBoundary } from '../internal/typed';
import type { ContractDef, ContractMeta, EndpointDef, Transport } from './define';
import { defineContract } from './define';
import {
  ExposureSchema,
  type HttpOnlyEndpointShape,
  type HttpOnlyFeature,
  isHttpOnlyEndpoint,
} from './endpoint-capabilities';

const ContractFactoryToolExposureSchema = z.strictObject({ default: ExposureSchema });
const ContractFactoryConfigSchema = z.strictObject({
  toolExposure: ContractFactoryToolExposureSchema,
});

export type ContractFactoryToolExposure = z.infer<typeof ContractFactoryToolExposureSchema>;
export type ContractFactoryConfig = z.infer<typeof ContractFactoryConfigSchema>;

type HttpExposure<Exposure extends readonly Transport[]> = Exposure extends readonly [
  infer First extends Transport,
  ...infer Rest extends readonly Transport[],
]
  ? First extends 'HTTP'
    ? readonly [First, ...HttpExposure<Rest>]
    : HttpExposure<Rest>
  : number extends Exposure['length']
    ? readonly Extract<Exposure[number], 'HTTP'>[]
    : readonly [];

type PossibleHttpOnlyFeature<Endpoint> = {
  [Feature in keyof Endpoint & HttpOnlyFeature]: Exclude<
    Endpoint[Feature],
    undefined | false
  > extends never
    ? never
    : Feature;
}[keyof Endpoint & HttpOnlyFeature];

type DefaultEndpointExposure<
  Endpoint,
  Defaults extends readonly Transport[],
> = Endpoint extends HttpOnlyEndpointShape
  ? HttpExposure<Defaults>
  : [PossibleHttpOnlyFeature<Endpoint>] extends [never]
    ? Defaults
    : Defaults | HttpExposure<Defaults>;

type WithEndpointExposure<Endpoint, Exposure> = Exposure extends readonly Transport[]
  ? Omit<Endpoint, 'expose'> & { expose: Exposure }
  : never;

type MaterializedEndpoint<Endpoint, Defaults extends readonly Transport[]> = Endpoint extends {
  expose: readonly Transport[];
}
  ? Endpoint
  : 'expose' extends keyof Endpoint
    ? WithEndpointExposure<
        Endpoint,
        Exclude<Endpoint['expose'], undefined> | DefaultEndpointExposure<Endpoint, Defaults>
      >
    : WithEndpointExposure<Endpoint, DefaultEndpointExposure<Endpoint, Defaults>>;

export type ConfiguredToolExposureEndpoints<
  T extends Record<string, EndpointDef>,
  Defaults extends readonly Transport[] = readonly ['HTTP'],
> = {
  [K in keyof T]: MaterializedEndpoint<T[K], Defaults>;
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
 * `T` itself unchanged, so `ConfiguredToolExposureEndpoints<T>` and the boundary
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

/** Scoped authoring with every omitted exposure materialized from the factory default. */
export type ConfiguredScopedDefineContract<
  TScope extends string,
  Defaults extends readonly Transport[] = readonly ['HTTP'],
> = <
  const TContractScope extends TScope,
  const T extends Record<string, FactoryScopedEndpoint<TScope>>,
>(
  meta: { prefix: string; scope: TContractScope; meta?: Record<string, unknown> },
  endpoints: T,
) => ScopedContractDef<ConfiguredToolExposureEndpoints<T, Defaults>, TContractScope>;

/**
 * Build a `defineContract` that requires a `scope` from the application's own
 * union. Call once per app and re-export the returned `defineContract`.
 */
export function createContractFactory<TScope extends string>(...args: []) {
  if (args.length !== 0) {
    throw new TypeError(
      'createContractFactory takes no arguments; use createContractFactory<Scope>().configure({ toolExposure: { default: [...] } })',
    );
  }
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

  // Keys outside the configuration schema are `never`, so a misspelled or extra
  // key fails to compile as it fails at run time. Written inline: a named helper
  // type in this public signature would be a public name.
  function configure<const Config extends ContractFactoryConfig>(
    config: Config & {
      readonly [Key in Exclude<keyof Config, keyof ContractFactoryConfig>]: never;
    } & {
      readonly toolExposure: {
        readonly [Key in Exclude<
          keyof Config['toolExposure'],
          keyof ContractFactoryToolExposure
        >]: never;
      };
    },
  ): {
    defineContract: ConfiguredScopedDefineContract<TScope, Config['toolExposure']['default']>;
  } {
    const defaults = ContractFactoryConfigSchema.parse(config).toolExposure.default;
    const httpDefaults = Object.freeze(defaults.filter((transport) => transport === 'HTTP'));
    const configured: ConfiguredScopedDefineContract<
      TScope,
      Config['toolExposure']['default']
    > = (meta, endpoints) => {
      const materialized = mapObjectTypeBoundary<
        typeof endpoints,
        ConfiguredToolExposureEndpoints<typeof endpoints, Config['toolExposure']['default']>
      >(endpoints, (_key, endpoint) =>
        endpoint.expose !== undefined
          ? endpoint
          : {
              ...endpoint,
              expose: isHttpOnlyEndpoint(endpoint) ? httpDefaults : defaults,
            },
      );
      return scoped(meta, materialized);
    };
    return { defineContract: configured };
  }

  return { defineContract: scoped, configure };
}
