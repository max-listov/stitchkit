import type { ContractDef, EndpointDef, TypedHttpClient } from '../contract';
import { inputIsQuery } from '../internal/http-input';
import { mapObject, typedEntries } from '../internal/typed';
import {
  ApiError,
  type HttpClient as HttpAdapter,
  parseApiErrorBody,
  type RequestOptions,
} from './http';

/** Merge an endpoint timeout into request options. */
function withTimeout(
  options: RequestOptions | undefined,
  timeout: number | undefined,
): RequestOptions | undefined {
  if (timeout === undefined) return options;
  return { ...options, timeout };
}

type QueryParams = Record<string, string | number | boolean | Array<string | number>>;

/** Narrow an unknown value to a query-param array (`string`/`number` items). */
function isParamArray(value: unknown): value is Array<string | number> {
  return (
    Array.isArray(value) && value.every((v) => typeof v === 'string' || typeof v === 'number')
  );
}

/**
 * Collect query params from a call's argument object — primitives passed
 * through, `string`/`number` arrays kept as arrays (repeated query keys),
 * path-param and other keys skipped. `undefined` when nothing qualifies.
 */
function collectQueryParams(
  args: Record<string, unknown>,
  skipKeys: Set<string>,
): QueryParams | undefined {
  const params: QueryParams = {};
  let hasParams = false;
  for (const [key, value] of Object.entries(args)) {
    if (skipKeys.has(key) || value === undefined || value === null) continue;
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      isParamArray(value)
    ) {
      params[key] = value;
      hasParams = true;
    }
  }
  return hasParams ? params : undefined;
}

/** Config for the built-in fetch client — used when no `HttpClient` is passed. */
export interface ClientConfig {
  baseUrl: string;
  headers?: Record<string, string> | (() => Record<string, string>);
  credentials?: RequestCredentials;
  onError?: (status: number, body: unknown) => void;
}

/** Per-contract client tweaks — a dynamic URL `pathPrefix` and the keys it consumes. */
export interface ContractClientConfig {
  pathPrefix?: string | ((args: Record<string, unknown>) => string);
  stripPrefixKeys?: string[];
}

/**
 * Build a fully-typed client from a contract. Every endpoint becomes a typed
 * method — arguments and result inferred from its schemas. Pass an `HttpClient`
 * (from `createHttpClient`) for cookie auth, SSR and retry, or a plain
 * `ClientConfig` for a bare fetch client.
 */
export function createClient<T extends Record<string, EndpointDef>>(
  contract: ContractDef<T, string>,
  configOrClient: ClientConfig | HttpAdapter,
  contractConfig?: ContractClientConfig,
): TypedHttpClient<T> {
  const client: Partial<TypedHttpClient<T>> = {};
  const makeMethod = isHttpAdapter(configOrClient)
    ? (endpoint: EndpointDef) =>
        createHttpMethod(endpoint, contract.meta.prefix, configOrClient, contractConfig)
    : (endpoint: EndpointDef) =>
        createFetchMethod(endpoint, contract.meta.prefix, configOrClient);

  for (const [key, endpoint] of typedEntries(contract.endpoints)) {
    if (endpoint.expose && !endpoint.expose.includes('HTTP')) continue;

    setClientMethod(client, key, makeMethod(endpoint));
  }

  return client as unknown as TypedHttpClient<T>;
}

/**
 * Batch form of `createClient` — one fully-typed client per contract, built
 * from a `name → contract` registry. Each key keeps its own client type, so
 * the project lists its contracts once and gets the whole typed API.
 */
export function createClients<
  T extends Record<string, ContractDef<Record<string, EndpointDef>, string>>,
>(contracts: T, http: HttpAdapter): { [K in keyof T]: TypedHttpClient<T[K]['endpoints']> } {
  return mapObject<T, { [K in keyof T]: TypedHttpClient<T[K]['endpoints']> }>(
    contracts,
    (_key, contract) => createClient(contract, http),
  );
}

function isHttpAdapter(value: ClientConfig | HttpAdapter): value is HttpAdapter {
  return typeof value === 'object' && 'get' in value && typeof value.get === 'function';
}

function setClientMethod(target: object, key: PropertyKey, method: unknown): void {
  (target as Record<PropertyKey, unknown>)[key] = method;
}

function createHttpMethod(
  endpoint: EndpointDef,
  prefix: string,
  client: HttpAdapter,
  config?: ContractClientConfig,
): (...args: unknown[]) => Promise<unknown> {
  const httpMethod = endpoint.method.toLowerCase() as
    | 'get'
    | 'post'
    | 'put'
    | 'patch'
    | 'delete';
  const isGet = httpMethod === 'get';
  const paramNames = extractParamNames(endpoint.path);
  const prefixKeys = new Set([...(config?.stripPrefixKeys ?? []), ...paramNames]);

  return (...args: unknown[]) => {
    const firstArg = (args[0] ?? {}) as Record<string, unknown>;

    let pathPrefixStr = '';
    if (config?.pathPrefix) {
      pathPrefixStr =
        typeof config.pathPrefix === 'function'
          ? config.pathPrefix(firstArg)
          : config.pathPrefix;
      if (pathPrefixStr && !pathPrefixStr.endsWith('/')) pathPrefixStr += '/';
    }

    let url = `${pathPrefixStr}${prefix}${endpoint.path}`;
    for (const name of paramNames) {
      const value = firstArg[name];
      if (value === undefined || value === null) {
        throw new Error(`Missing path param: ${name}`);
      }
      url = url.replace(`:${name}`, encodeURIComponent(String(value)));
    }
    if (url.endsWith('/')) url = url.slice(0, -1);

    if (endpoint.multipart) {
      const file = firstArg[endpoint.multipart];
      if (!(file instanceof Blob)) {
        throw new Error(`Missing multipart file field: ${endpoint.multipart}`);
      }
      const formData = new FormData();
      formData.append(endpoint.multipart, file);
      appendFormFields(formData, firstArg, new Set([...prefixKeys, endpoint.multipart]));
      return client.post(url, formData, withTimeout(undefined, endpoint.timeout));
    }

    if (isGet) {
      const params = collectQueryParams(firstArg, prefixKeys);
      return client.get(url, withTimeout(params ? { params } : undefined, endpoint.timeout));
    }

    if (httpMethod === 'delete') {
      const params = collectQueryParams(firstArg, prefixKeys);
      return client.delete(
        url,
        withTimeout(params ? { params } : undefined, endpoint.timeout),
      );
    }

    const payload: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(firstArg)) {
      if (!prefixKeys.has(key) && value !== undefined) {
        payload[key] = value;
      }
    }
    return client[httpMethod](
      url,
      Object.keys(payload).length > 0 ? payload : undefined,
      withTimeout(undefined, endpoint.timeout),
    );
  };
}

function createFetchMethod(
  endpoint: EndpointDef,
  prefix: string,
  config: ClientConfig,
): (args?: Record<string, unknown>) => Promise<unknown> {
  return async (args?: Record<string, unknown>) => {
    let url = buildFetchUrl(config.baseUrl, prefix, endpoint.path, args);

    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...(typeof config.headers === 'function' ? config.headers() : config.headers),
    };

    const isQuery = inputIsQuery(endpoint.method);
    const hasBody = !isQuery && !endpoint.multipart && endpoint.input && args;

    if (isQuery && args) {
      const remaining = stripParams(args, endpoint.path);
      const searchParams = new URLSearchParams();
      for (const [k, v] of Object.entries(remaining)) {
        if (v === undefined || v === null) continue;
        if (isParamArray(v)) {
          for (const item of v) searchParams.append(k, String(item));
        } else if (typeof v !== 'object') {
          searchParams.set(k, String(v));
        }
      }
      if (searchParams.size > 0) url += `?${searchParams}`;
    }

    if (hasBody) headers['Content-Type'] = 'application/json';

    if (endpoint.multipart && args) {
      const file = args[endpoint.multipart];
      if (!(file instanceof Blob)) {
        throw new Error(`Missing multipart file field: ${endpoint.multipart}`);
      }
      const formData = new FormData();
      formData.append(endpoint.multipart, file);
      appendFormFields(
        formData,
        stripParams(args, endpoint.path),
        new Set([endpoint.multipart]),
      );

      const res = await fetch(url, {
        method: endpoint.method,
        headers,
        credentials: config.credentials,
        body: formData,
      });

      if (!res.ok) {
        await throwForErrorResponse(res, config, null);
      }

      if (res.status === 204) return undefined;

      const json = await res.json();
      return endpoint.output ? endpoint.output.parse(json) : json;
    }

    const res = await fetch(url, {
      method: endpoint.method,
      headers,
      credentials: config.credentials,
      ...(hasBody && { body: JSON.stringify(stripParams(hasBody, endpoint.path)) }),
    });

    if (!res.ok) {
      await throwForErrorResponse(res, config, { error: res.statusText });
    }

    if (res.status === 204) return undefined;

    const json = await res.json();
    return endpoint.output ? endpoint.output.parse(json) : json;
  };
}

function appendFormFields(
  formData: FormData,
  values: Record<string, unknown>,
  skipKeys: Set<string>,
): void {
  for (const [key, value] of Object.entries(values)) {
    if (skipKeys.has(key) || value === undefined || value === null) continue;
    formData.append(key, typeof value === 'string' ? value : JSON.stringify(value));
  }
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
    throw new ApiError(parsed.code, res.status, parsed.details, parsed.message, parsed.hint);
  }
  throw new ApiError('HTTP_ERROR', res.status, { body });
}

function extractParamNames(path: string): string[] {
  const matches = path.match(/:(\w+)/g);
  return matches ? matches.map((m) => m.slice(1)) : [];
}

function buildFetchUrl(
  baseUrl: string,
  prefix: string,
  path: string,
  args?: Record<string, unknown>,
): string {
  let fullPath = `/${prefix}${path === '/' ? '' : path}`;
  if (args) {
    fullPath = fullPath.replace(/:(\w+)/g, (_, key) => {
      const val = args[key];
      if (val === undefined || val === null) {
        throw new Error(`Missing path param: ${key}`);
      }
      return encodeURIComponent(String(val));
    });
  }
  return `${baseUrl}${fullPath}`;
}

function stripParams(args: Record<string, unknown>, path: string): Record<string, unknown> {
  const paramNames = new Set<string>();
  for (const match of path.matchAll(/:(\w+)/g)) {
    if (match[1]) paramNames.add(match[1]);
  }
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (!paramNames.has(k)) result[k] = v;
  }
  return result;
}
