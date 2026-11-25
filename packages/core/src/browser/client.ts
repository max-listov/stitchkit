import type {
  ClientRequestOptions,
  ScopedHttpClient,
  ScopedUrlBuilder,
  TypedHttpClient,
  TypedUrlBuilder,
} from '../contract/client-types';
import type { ContractDef, EndpointDef } from '../contract/define';
import { mapObject, typedEntries } from '../internal/typed';
import { type BoundEndpointArguments, boundEndpointArguments } from './client-bound';
import {
  readClientRequestArgs,
  readClientRequestOptions,
  refuseExtraWithOptionsArguments,
} from './client-call-arguments';
import {
  type ClientRequestExecutor,
  createFetchExecutor,
  createHttpExecutor,
} from './client-executors';
import { createClientRouteMatcher, joinClientBaseUrl, planClientRequest } from './client-url';
import type { HttpClient as HttpAdapter, UnauthorizedMatcher } from './http';
import type { ClientFetch } from './transport';
import { namedOperation } from './unknown-operation';

export type { ClientFetch } from './transport';

export interface ClientConfig {
  baseUrl: string;
  /** Override Web Fetch delivery while preserving the complete client pipeline. */
  fetch?: ClientFetch;
  timeout?: number;
  headers?: Record<string, string> | (() => Record<string, string>);
  credentials?: NonNullable<RequestInit['credentials']>;
  onError?: (status: number, body: unknown) => void;
  /**
   * How many times a call that never got an answer — a network failure, not a
   * response — is sent again, when its endpoint allows it: `idempotent: true`,
   * or a `GET`/`HEAD` that says neither `idempotent: false` nor `effect: 'write'`.
   * Default 2.
   */
  retry?: { limit?: number };
}

/**
 * The keys a `pathPrefix` consumes, as required `string` args. `never` (a plain
 * client) collapses to `unknown`, so `EndpointArgs & unknown = EndpointArgs`.
 */
export type ScopedKeys<K extends string> = [K] extends [never]
  ? unknown
  : { [P in K]: string };

/** The declared keys available to a dynamic path-prefix callback. */
export type PathPrefixArgs<K extends string> = { [P in K]: string };

/**
 * Per-contract client tweaks — a dynamic URL `pathPrefix` and the keys it
 * consumes. List the consumed keys in `stripPrefixKeys` (e.g. `['tenantId']`)
 * and they become required, typed args on every method of the returned client —
 * no hand-written scoped-client wrapper.
 */
export interface ContractClientConfig<
  K extends string = never,
  B extends Record<string, unknown> = Record<never, never>,
> {
  pathPrefix?: string | ((args: PathPrefixArgs<K>) => string);
  stripPrefixKeys?: readonly K[];
  /**
   * Arguments given once for every call, e.g. `{ tenantId }`. A bound key leaves the args of
   * every method, and a method whose every argument is bound is called with none. The value goes
   * where the caller's argument would: a path parameter, a prefix key, the query or the body.
   * An endpoint that does not declare the key does not receive it.
   */
  bound?: B;
}

/**
 * Build exact expected-401 pathname matchers from selected contract operations.
 * Omit `endpointNames` to select every HTTP-exposed operation in the contract.
 */
export function contractEndpointMatchers<
  T extends Record<string, EndpointDef>,
  const Names extends readonly (keyof T)[],
  const K extends string = never,
>(
  contract: ContractDef<T, string>,
  endpointNames?: Names,
  contractConfig?: ContractClientConfig<K>,
): UnauthorizedMatcher[] {
  const selected = endpointNames ? new Set<PropertyKey>(endpointNames) : null;
  const matchers: UnauthorizedMatcher[] = [];
  for (const [key, endpoint] of typedEntries(contract.endpoints)) {
    if (selected && !selected.has(key)) continue;
    if (endpoint.expose && !endpoint.expose.includes('HTTP')) {
      if (selected) {
        throw new Error(
          `Cannot create an HTTP route matcher for non-HTTP endpoint: ${String(key)}`,
        );
      }
      continue;
    }
    matchers.push(createClientRouteMatcher(endpoint, contract.meta.prefix, contractConfig));
  }
  if (selected && matchers.length !== selected.size) {
    throw new Error('Cannot create an HTTP route matcher for an unknown endpoint');
  }
  return matchers;
}

/**
 * Build a fully-typed client from a contract. Every endpoint becomes a typed
 * method — arguments and result inferred from its schemas. Pass an `HttpClient`
 * (from `createHttpClient`) for cookie auth, SSR and retry, or a plain
 * `ClientConfig` for a bare fetch client.
 */
export function createClient<
  T extends Record<string, EndpointDef>,
  const K extends string = never,
  const B extends Record<string, unknown> = Record<never, never>,
>(
  contract: ContractDef<T, string>,
  configOrClient: ClientConfig | HttpAdapter,
  contractConfig?: ContractClientConfig<K, B>,
): ScopedHttpClient<T, ScopedKeys<K>, keyof B> {
  const client: Partial<TypedHttpClient<T>> = {};
  const makeExecutor = isHttpAdapter(configOrClient)
    ? (endpoint: EndpointDef) =>
        createHttpExecutor(endpoint, contract.meta.prefix, configOrClient, contractConfig)
    : (endpoint: EndpointDef) =>
        createFetchExecutor(endpoint, contract.meta.prefix, configOrClient, contractConfig);

  for (const [key, endpoint] of typedEntries(contract.endpoints)) {
    if (endpoint.expose && !endpoint.expose.includes('HTTP')) continue;

    setClientMethod(
      client,
      key,
      createEndpointMethod(
        endpoint,
        namedOperation(makeExecutor(endpoint), `${contract.meta.prefix}.${String(key)}`),
        boundEndpointArguments(endpoint, contract.meta.prefix, contractConfig),
      ),
    );
  }

  return client as unknown as ScopedHttpClient<T, ScopedKeys<K>, keyof B>;
}

/**
 * Batch form of `createClient` — one fully-typed client per contract, built
 * from a `name → contract` registry. Each key keeps its own client type, so
 * the project lists its contracts once and gets the whole typed API.
 */
export function createClients<
  T extends Record<string, ContractDef<Record<string, EndpointDef>, string>>,
  const K extends string = never,
  const B extends Record<string, unknown> = Record<never, never>,
>(
  contracts: T,
  configOrClient: ClientConfig | HttpAdapter,
  contractConfig?: ContractClientConfig<K, B>,
): { [P in keyof T]: ScopedHttpClient<T[P]['endpoints'], ScopedKeys<K>, keyof B> } {
  type BatchClients = {
    [P in keyof T]: ScopedHttpClient<T[P]['endpoints'], ScopedKeys<K>, keyof B>;
  };
  return mapObject<T, BatchClients>(contracts, (_key, contract) =>
    createClient(contract, configOrClient, contractConfig),
  );
}

export type ClientContract = ContractDef<Record<string, EndpointDef>, string>;
export type ClientRegistryValue = ClientContract | readonly ClientContract[];

export type ScopeClientConfigs<TScope extends string> = {
  [S in TScope]: ContractClientConfig<string, Record<string, unknown>>;
};

type RegistryContract<R> = R extends readonly (infer C)[] ? C : R;
export type RegistryScope<R> =
  RegistryContract<R> extends ContractDef<Record<string, EndpointDef>, infer S> ? S : never;
type PrefixKeys<C> = C extends { stripPrefixKeys: readonly (infer K extends string)[] }
  ? K
  : never;
type BoundKeys<C> = C extends { bound: infer B } ? keyof B : never;
type ClientForContract<C, Configs> =
  C extends ContractDef<infer E, infer S>
    ? S extends keyof Configs
      ? ScopedHttpClient<E, ScopedKeys<PrefixKeys<Configs[S]>>, BoundKeys<Configs[S]>>
      : never
    : never;
type UnionToIntersection<U> = (U extends unknown ? (value: U) => void : never) extends (
  value: infer I,
) => void
  ? I
  : never;
type ScopedNamespace<R, Configs> = UnionToIntersection<
  ClientForContract<RegistryContract<R>, Configs>
>;
type UrlBuilderForContract<C, Configs> =
  C extends ContractDef<infer E, infer S>
    ? S extends keyof Configs
      ? ScopedUrlBuilder<E, ScopedKeys<PrefixKeys<Configs[S]>>, BoundKeys<Configs[S]>>
      : never
    : never;
type ScopedUrlNamespace<R, Configs> = UnionToIntersection<
  UrlBuilderForContract<RegistryContract<R>, Configs>
>;

export type ScopedClientRegistry<T extends Record<string, ClientRegistryValue>, Configs> = {
  [P in keyof T]: ScopedNamespace<T[P], Configs>;
};

export type ScopedUrlBuilderRegistry<
  T extends Record<string, ClientRegistryValue>,
  Configs,
> = {
  [P in keyof T]: ScopedUrlNamespace<T[P], Configs>;
};

function buildScopedRegistry<Output>(
  contracts: Record<string, ClientRegistryValue>,
  scopeConfigs: Record<string, ContractClientConfig<string, Record<string, unknown>>>,
  surfaceName: string,
  build: (
    contract: ClientContract,
    config: ContractClientConfig<string, Record<string, unknown>>,
  ) => object,
): Output {
  const registry: Record<string, object> = {};
  for (const [namespace, value] of Object.entries(contracts)) {
    const list: readonly ClientContract[] = Array.isArray(value) ? value : [value];
    const surface: Record<PropertyKey, unknown> = {};
    for (const contract of list) {
      const scope = contract.meta.scope;
      if (!scope) {
        throw new Error(`Contract in ${surfaceName} namespace "${namespace}" has no scope`);
      }
      const scopeConfig = scopeConfigs[scope];
      if (!scopeConfig) {
        throw new Error(`Missing ${surfaceName} config for scope: ${scope}`);
      }
      for (const [methodName, method] of Object.entries(build(contract, scopeConfig))) {
        if (Object.hasOwn(surface, methodName)) {
          throw new Error(
            `${surfaceName[0]?.toUpperCase()}${surfaceName.slice(1)} namespace "${namespace}" has duplicate method: ${methodName}`,
          );
        }
        surface[methodName] = method;
      }
    }
    registry[namespace] = surface;
  }
  // Typed registry construction is the loose→exact boundary; every method was
  // produced by createClient/createUrlBuilder from the corresponding contract.
  return registry as Output;
}

/** Build one client registry routed by contract scope; arrays compose a namespace. */
export function createScopedClients<
  const T extends Record<string, ClientRegistryValue>,
  const Configs extends ScopeClientConfigs<RegistryScope<T[keyof T]>>,
>(
  contracts: T,
  configOrClient: ClientConfig | HttpAdapter,
  scopeConfigs: Configs,
): ScopedClientRegistry<T, Configs> {
  return buildScopedRegistry<ScopedClientRegistry<T, Configs>>(
    contracts,
    scopeConfigs,
    'client',
    (contract, config) => createClient(contract, configOrClient, config),
  );
}

function isHttpAdapter(value: ClientConfig | HttpAdapter): value is HttpAdapter {
  return typeof value === 'object' && 'get' in value && typeof value.get === 'function';
}

function setClientMethod(target: object, key: PropertyKey, method: unknown): void {
  (target as Record<PropertyKey, unknown>)[key] = method;
}

function createEndpointMethod(
  endpoint: EndpointDef,
  execute: ClientRequestExecutor,
  bound: BoundEndpointArguments,
): unknown {
  if (!bound.complete) {
    // A bound value wins over the same key in the call: the type does not offer that key.
    const readArgs = (requestArgs: unknown): Record<string, unknown> => ({
      ...readClientRequestArgs(requestArgs),
      ...bound.values,
    });
    const method = (requestArgs: unknown) => settle(execute, readArgs(requestArgs), undefined);
    return Object.assign(method, {
      withOptions: (...args: unknown[]) => {
        refuseExtraWithOptionsArguments(endpoint, args.length, 2);
        return settle(execute, readArgs(args[0]), readClientRequestOptions(endpoint, args[1]));
      },
    });
  }

  const method = () => settle(execute, { ...bound.values }, undefined);
  return Object.assign(method, {
    withOptions: (...args: unknown[]) => {
      refuseExtraWithOptionsArguments(endpoint, args.length, 1);
      return settle(execute, { ...bound.values }, readClientRequestOptions(endpoint, args[0]));
    },
  });
}

/**
 * Run an executor so that a refusal always arrives as a rejection.
 *
 * The two executors differ in a way no caller should ever have seen: the bare-fetch one is `async`,
 * so a refusal raised while planning the request becomes a rejection, while the Ky-backed one is a
 * plain function and threw the same refusal **synchronously** — `api.upload({}).catch(handler)`
 * never reached the handler, and `expect(...).rejects` on one transport had to be
 * `expect(() => ...).toThrow` on the other for the identical mistake.
 *
 * This is deliberately the funnel and not the executors: every method goes through here, so the
 * guarantee cannot be true of one call shape and false of another. The `TypeError`s above it stay
 * synchronous on purpose — a wrong argument *count* or a non-object options bag is a programming
 * error at the call site, not a request this client refused to send.
 */
function settle(
  execute: ClientRequestExecutor,
  requestArgs: Record<string, unknown>,
  options: ClientRequestOptions | undefined,
): Promise<unknown> {
  try {
    return execute(requestArgs, options);
  } catch (error) {
    return Promise.reject(error);
  }
}

/** Base URL source for synchronous contract URL builders. */
export interface UrlBuilderConfig {
  baseUrl: string;
}

export function createUrlBuilder<
  T extends Record<string, EndpointDef>,
  const K extends string = never,
  const B extends Record<string, unknown> = Record<never, never>,
>(
  contract: ContractDef<T, string>,
  source: UrlBuilderConfig,
  contractConfig?: ContractClientConfig<K, B>,
): ScopedUrlBuilder<T, ScopedKeys<K>, keyof B> {
  const builder: Partial<TypedUrlBuilder<T>> = {};
  for (const [key, endpoint] of typedEntries(contract.endpoints)) {
    if (endpoint.expose && !endpoint.expose.includes('HTTP')) continue;
    const bound = boundEndpointArguments(
      endpoint,
      contract.meta.prefix,
      contractConfig,
      'url',
    );
    setClientMethod(builder, key, (args?: Record<string, unknown>) => {
      const plan = planClientRequest(
        endpoint,
        contract.meta.prefix,
        { ...args, ...bound.values },
        contractConfig,
      );
      if (
        endpoint.method !== 'GET' &&
        endpoint.method !== 'DELETE' &&
        Object.keys(plan.remainingArgs).length > 0
      ) {
        const fields = Object.keys(plan.remainingArgs).join(', ');
        throw new Error(
          `URL builder for ${endpoint.method} ${endpoint.path} received non-URL fields: ${fields}`,
        );
      }
      return joinClientBaseUrl(source.baseUrl, plan.relativeUrl);
    });
  }
  return builder as unknown as ScopedUrlBuilder<T, ScopedKeys<K>, keyof B>;
}

export function createUrlBuilders<
  T extends Record<string, ContractDef<Record<string, EndpointDef>, string>>,
  const K extends string = never,
  const B extends Record<string, unknown> = Record<never, never>,
>(
  contracts: T,
  source: UrlBuilderConfig,
  contractConfig?: ContractClientConfig<K, B>,
): { [P in keyof T]: ScopedUrlBuilder<T[P]['endpoints'], ScopedKeys<K>, keyof B> } {
  type BatchBuilders = {
    [P in keyof T]: ScopedUrlBuilder<T[P]['endpoints'], ScopedKeys<K>, keyof B>;
  };
  return mapObject<T, BatchBuilders>(contracts, (_key, contract) =>
    createUrlBuilder(contract, source, contractConfig),
  );
}

/** Build one URL registry routed by contract scope; arrays compose a namespace. */
export function createScopedUrlBuilders<
  const T extends Record<string, ClientRegistryValue>,
  const Configs extends ScopeClientConfigs<RegistryScope<T[keyof T]>>,
>(
  contracts: T,
  source: UrlBuilderConfig,
  scopeConfigs: Configs,
): ScopedUrlBuilderRegistry<T, Configs> {
  return buildScopedRegistry<ScopedUrlBuilderRegistry<T, Configs>>(
    contracts,
    scopeConfigs,
    'URL builder',
    (contract, config) => createUrlBuilder(contract, source, config),
  );
}
