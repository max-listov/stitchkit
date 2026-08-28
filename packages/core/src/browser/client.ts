import type {
  ClientRequestOptions,
  ContractDef,
  EndpointDef,
  ScopedHttpClient,
  ScopedUrlBuilder,
  TypedHttpClient,
  TypedUrlBuilder,
} from '../contract';
import { isRecord, mapObject, typedEntries } from '../internal/typed';
import { createRequestCancellation, RequestCancellationError } from './cancellation';
import { buildMultipartForm } from './client-multipart';
import { createClientRouteMatcher, joinClientBaseUrl, planClientRequest } from './client-url';
import { parseContractStream } from './contract-stream';
import {
  ApiError,
  type HttpClient as HttpAdapter,
  parseApiErrorBody,
  type RequestOptions,
  type UnauthorizedMatcher,
} from './http';
import { responseTraceId } from './request-id';
import type { ClientFetch } from './transport';

export type { ClientFetch } from './transport';

/** Merge an endpoint's timeout and response mode into request options. */
function withTimeout(
  options: RequestOptions | undefined,
  endpoint: EndpointDef,
): RequestOptions | undefined {
  // A raw endpoint answers with bytes — parsing it as JSON is how the old
  // hand-rolled transports produced empty objects. → ADR 0038.
  const responseType: RequestOptions['responseType'] =
    endpoint.rawResponse || 'stream' in endpoint
      ? 'response'
      : endpoint.output
        ? undefined
        : 'void';
  if (endpoint.timeout === undefined && responseType === undefined) return options;
  return {
    ...options,
    ...(endpoint.timeout !== undefined && { timeout: endpoint.timeout }),
    ...(responseType && { responseType }),
  };
}

/**
 * Validate a resolved response through the endpoint's `output` schema when it
 * declares one — the contract's documented guarantee ("the client parses the
 * response through it"). The contract — not the server's runtime value — owns
 * whether a response exists. Applied on both client paths so the guarantee
 * cannot depend on which one a project wired.
 */
function withOutput(
  endpoint: EndpointDef,
  result: Promise<unknown>,
  abortStream?: () => void,
): Promise<unknown> {
  if (endpoint.rawResponse) return result;
  if ('stream' in endpoint && endpoint.stream) {
    return result.then(
      (value) => {
        if (!(value instanceof Response)) {
          abortStream?.();
          throw new Error('Streaming endpoint did not return a Response');
        }
        return parseContractStream(value, endpoint.stream, abortStream ?? (() => undefined));
      },
      (error: unknown) => {
        abortStream?.();
        throw error;
      },
    );
  }
  const schema = endpoint.output;
  return result.then((value) => {
    if (!schema) {
      if (value === undefined || value === null) return undefined;
      throw new Error('Server returned data for an endpoint with no output contract');
    }
    if (value === undefined) {
      throw new Error('Server returned no body for an endpoint with an output contract');
    }
    return schema.parse(value);
  });
}

export interface ClientConfig {
  baseUrl: string;
  /** Override Web Fetch delivery while preserving the complete client pipeline. */
  fetch?: ClientFetch;
  timeout?: number;
  headers?: Record<string, string> | (() => Record<string, string>);
  credentials?: RequestCredentials;
  onError?: (status: number, body: unknown) => void;
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
export interface ContractClientConfig<K extends string = never> {
  pathPrefix?: string | ((args: PathPrefixArgs<K>) => string);
  stripPrefixKeys?: readonly K[];
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
>(
  contract: ContractDef<T, string>,
  configOrClient: ClientConfig | HttpAdapter,
  contractConfig?: ContractClientConfig<K>,
): ScopedHttpClient<T, ScopedKeys<K>> {
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
      createEndpointMethod(endpoint, makeExecutor(endpoint), contractConfig),
    );
  }

  return client as unknown as ScopedHttpClient<T, ScopedKeys<K>>;
}

/**
 * Batch form of `createClient` — one fully-typed client per contract, built
 * from a `name → contract` registry. Each key keeps its own client type, so
 * the project lists its contracts once and gets the whole typed API.
 */
export function createClients<
  T extends Record<string, ContractDef<Record<string, EndpointDef>, string>>,
  const K extends string = never,
>(
  contracts: T,
  configOrClient: ClientConfig | HttpAdapter,
  contractConfig?: ContractClientConfig<K>,
): { [P in keyof T]: ScopedHttpClient<T[P]['endpoints'], ScopedKeys<K>> } {
  type BatchClients = {
    [P in keyof T]: ScopedHttpClient<T[P]['endpoints'], ScopedKeys<K>>;
  };
  return mapObject<T, BatchClients>(contracts, (_key, contract) =>
    createClient(contract, configOrClient, contractConfig),
  );
}

export type ClientContract = ContractDef<Record<string, EndpointDef>, string>;
export type ClientRegistryValue = ClientContract | readonly ClientContract[];

export type ScopeClientConfigs<TScope extends string> = {
  [S in TScope]: ContractClientConfig<string>;
};

type RegistryContract<R> = R extends readonly (infer C)[] ? C : R;
export type RegistryScope<R> =
  RegistryContract<R> extends ContractDef<Record<string, EndpointDef>, infer S> ? S : never;
type PrefixKeys<C> = C extends { stripPrefixKeys: readonly (infer K extends string)[] }
  ? K
  : never;
type ClientForContract<C, Configs> =
  C extends ContractDef<infer E, infer S>
    ? S extends keyof Configs
      ? ScopedHttpClient<E, ScopedKeys<PrefixKeys<Configs[S]>>>
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
      ? ScopedUrlBuilder<E, ScopedKeys<PrefixKeys<Configs[S]>>>
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
  scopeConfigs: Record<string, ContractClientConfig<string>>,
  surfaceName: string,
  build: (contract: ClientContract, config: ContractClientConfig<string>) => object,
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

type ClientRequestExecutor = (
  requestArgs: Record<string, unknown>,
  options?: ClientRequestOptions,
) => Promise<unknown>;

function createEndpointMethod<K extends string>(
  endpoint: EndpointDef,
  execute: ClientRequestExecutor,
  contractConfig?: ContractClientConfig<K>,
): unknown {
  const hasScopedArguments = (contractConfig?.stripPrefixKeys?.length ?? 0) > 0;
  if (endpointHasArguments(endpoint) || hasScopedArguments) {
    const method = (requestArgs: unknown) =>
      execute(readClientRequestArgs(requestArgs), undefined);
    return Object.assign(method, {
      withOptions: (requestArgs: unknown, options: unknown) =>
        execute(readClientRequestArgs(requestArgs), readClientRequestOptions(options)),
    });
  }

  const method = () => execute({}, undefined);
  return Object.assign(method, {
    withOptions: (options: unknown) => execute({}, readClientRequestOptions(options)),
  });
}

function createHttpExecutor<K extends string>(
  endpoint: EndpointDef,
  prefix: string,
  client: HttpAdapter,
  config?: ContractClientConfig<K>,
): ClientRequestExecutor {
  const httpMethod = endpoint.method.toLowerCase() as
    | 'get'
    | 'head'
    | 'post'
    | 'put'
    | 'patch'
    | 'delete';
  return (requestArgs, options) => {
    const plan = planClientRequest(endpoint, prefix, requestArgs, config);
    const streamAbort = 'stream' in endpoint ? new AbortController() : undefined;
    const requestOptions = streamAbort
      ? {
          ...options,
          signal: options?.signal
            ? AbortSignal.any([options.signal, streamAbort.signal])
            : streamAbort.signal,
        }
      : options;
    const finishStream = streamAbort ? () => streamAbort.abort() : undefined;

    if (endpoint.multipart) {
      // Multipart uses the endpoint's declared body verb — a `PUT` upload must
      // not silently become a `POST` (the bare-fetch path already honours it).
      if (httpMethod === 'get' || httpMethod === 'head' || httpMethod === 'delete') {
        throw new Error(
          `Multipart endpoint ${endpoint.method} ${endpoint.path} must be POST / PUT / PATCH`,
        );
      }
      const formData = buildMultipartForm(endpoint.multipart, plan.remainingArgs);
      return withOutput(
        endpoint,
        client[httpMethod](plan.relativeUrl, formData, withTimeout(requestOptions, endpoint)),
        finishStream,
      );
    }

    if (httpMethod === 'get' || httpMethod === 'head') {
      return withOutput(
        endpoint,
        client[httpMethod](plan.relativeUrl, withTimeout(requestOptions, endpoint)),
        finishStream,
      );
    }

    if (httpMethod === 'delete') {
      return withOutput(
        endpoint,
        client.delete(plan.relativeUrl, withTimeout(requestOptions, endpoint)),
        finishStream,
      );
    }

    return withOutput(
      endpoint,
      client[httpMethod](
        plan.relativeUrl,
        Object.keys(plan.remainingArgs).length > 0 ? plan.remainingArgs : undefined,
        withTimeout(requestOptions, endpoint),
      ),
      finishStream,
    );
  };
}

function createFetchExecutor<K extends string>(
  endpoint: EndpointDef,
  prefix: string,
  config: ClientConfig,
  contractConfig?: ContractClientConfig<K>,
): ClientRequestExecutor {
  const executeFetch = config.fetch ?? globalThis.fetch;
  return async (requestArgs, options) => {
    const plan = planClientRequest(endpoint, prefix, requestArgs, contractConfig);
    const url = joinClientBaseUrl(config.baseUrl, plan.relativeUrl);

    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...(typeof config.headers === 'function' ? config.headers() : config.headers),
    };

    // Apply the endpoint's declared `timeout` — the HttpClient path already did;
    // the bare-fetch path used to ignore it, so a declared timeout silently did
    // nothing here.
    const streamAbort = 'stream' in endpoint ? new AbortController() : undefined;
    const requestSignal = streamAbort
      ? options?.signal
        ? AbortSignal.any([options.signal, streamAbort.signal])
        : streamAbort.signal
      : options?.signal;
    const openTimeoutMs = endpoint.timeout ?? config.timeout ?? 30_000;
    const cancellation = streamAbort
      ? {
          signal: requestSignal,
          async run<T>(operation: (signal?: AbortSignal) => Promise<T>): Promise<T> {
            let timedOut = false;
            const timer = setTimeout(() => {
              timedOut = true;
              streamAbort.abort(new DOMException('Request timed out', 'TimeoutError'));
            }, openTimeoutMs);
            try {
              if (options?.signal?.aborted) throw new RequestCancellationError('caller');
              return await operation(requestSignal);
            } catch (error) {
              if (timedOut) throw new RequestCancellationError('timeout');
              if (options?.signal?.aborted) throw new RequestCancellationError('caller');
              throw error;
            } finally {
              clearTimeout(timer);
            }
          },
        }
      : createRequestCancellation(requestSignal, openTimeoutMs);

    const hasBody =
      endpoint.method !== 'GET' &&
      endpoint.method !== 'HEAD' &&
      endpoint.method !== 'DELETE' &&
      !endpoint.multipart &&
      endpoint.input &&
      Object.keys(plan.remainingArgs).length > 0;

    if (hasBody) headers['Content-Type'] = 'application/json';

    try {
      return await cancellation.run(async (signal) => {
        const body = endpoint.multipart
          ? buildMultipartForm(endpoint.multipart, plan.remainingArgs)
          : hasBody
            ? JSON.stringify(plan.remainingArgs)
            : undefined;
        const res = await executeFetch(url, {
          method: endpoint.method,
          headers,
          credentials: config.credentials,
          signal,
          ...(body !== undefined && { body }),
        });

        if (!res.ok) {
          await throwForErrorResponse(res, config, { error: res.statusText });
        }

        if (endpoint.rawResponse) return res;

        if ('stream' in endpoint && endpoint.stream) {
          return parseContractStream(res, endpoint.stream, () => streamAbort?.abort());
        }

        if (!endpoint.output) {
          const text = await res.text();
          if (text.length > 0) {
            throw new Error('Server returned data for an endpoint with no output contract');
          }
          return undefined;
        }

        return endpoint.output.parse(await res.json());
      });
    } catch (error) {
      if (error instanceof RequestCancellationError) {
        throw new ApiError(
          error.cause === 'caller' ? 'REQUEST_ABORTED' : 'REQUEST_TIMEOUT',
          0,
          undefined,
          error.message,
        );
      }
      if (ApiError.is(error)) throw error;
      const message = error instanceof Error ? error.message : undefined;
      throw new ApiError(
        'UNKNOWN_ERROR',
        0,
        message ? { message } : undefined,
        message,
        undefined,
        undefined,
        { cause: error },
      );
    }
  };
}

function endpointHasArguments(endpoint: EndpointDef): boolean {
  return Boolean(endpoint.params || endpoint.input || endpoint.multipart);
}

function readClientRequestArgs(requestArgs: unknown): Record<string, unknown> {
  if (requestArgs !== undefined && !isRecord(requestArgs)) {
    throw new TypeError('Endpoint arguments must be an object');
  }
  return requestArgs ?? {};
}

function readClientRequestOptions(value: unknown): ClientRequestOptions {
  if (!isRecord(value)) throw new TypeError('Client request options must be an object');
  const signal = value.signal;
  if (signal === undefined) return {};
  if (!isAbortSignal(signal)) {
    throw new TypeError('Client request signal must be an AbortSignal');
  }
  return { signal };
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return (
    typeof value === 'object' &&
    value !== null &&
    'aborted' in value &&
    typeof value.aborted === 'boolean' &&
    'addEventListener' in value &&
    typeof value.addEventListener === 'function' &&
    'removeEventListener' in value &&
    typeof value.removeEventListener === 'function'
  );
}

/** Read an error response, fire `onError`, throw a typed `ApiError` — never returns. */
async function throwForErrorResponse(
  res: Response,
  config: ClientConfig,
  fallbackBody: unknown,
): Promise<never> {
  const body = await res.json().catch(() => fallbackBody);
  config.onError?.(res.status, body);
  const parsed = parseApiErrorBody(body);
  if (parsed) {
    throw new ApiError(
      parsed.code,
      res.status,
      parsed.details,
      parsed.message,
      parsed.hint,
      responseTraceId(res),
    );
  }
  throw new ApiError(
    'HTTP_ERROR',
    res.status,
    { body },
    undefined,
    undefined,
    responseTraceId(res),
  );
}

/** Base URL source for synchronous contract URL builders. */
export interface UrlBuilderConfig {
  baseUrl: string;
}

export function createUrlBuilder<
  T extends Record<string, EndpointDef>,
  const K extends string = never,
>(
  contract: ContractDef<T, string>,
  source: UrlBuilderConfig,
  contractConfig?: ContractClientConfig<K>,
): ScopedUrlBuilder<T, ScopedKeys<K>> {
  const builder: Partial<TypedUrlBuilder<T>> = {};
  for (const [key, endpoint] of typedEntries(contract.endpoints)) {
    if (endpoint.expose && !endpoint.expose.includes('HTTP')) continue;
    setClientMethod(builder, key, (args?: Record<string, unknown>) => {
      const plan = planClientRequest(
        endpoint,
        contract.meta.prefix,
        args ?? {},
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
  return builder as unknown as ScopedUrlBuilder<T, ScopedKeys<K>>;
}

export function createUrlBuilders<
  T extends Record<string, ContractDef<Record<string, EndpointDef>, string>>,
  const K extends string = never,
>(
  contracts: T,
  source: UrlBuilderConfig,
  contractConfig?: ContractClientConfig<K>,
): { [P in keyof T]: ScopedUrlBuilder<T[P]['endpoints'], ScopedKeys<K>> } {
  type BatchBuilders = {
    [P in keyof T]: ScopedUrlBuilder<T[P]['endpoints'], ScopedKeys<K>>;
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
