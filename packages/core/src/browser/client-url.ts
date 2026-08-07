import type { EndpointDef } from '../contract';
import { inputIsQuery } from '../internal/http-input';
import { parseTrailingWildcard } from '../internal/route-pattern';
import type { ContractClientConfig, PathPrefixArgs } from './client';

type QueryParams = Record<string, string | number | boolean | Array<string | number>>;

export interface ClientRequestPlan {
  relativeUrl: string;
  remainingArgs: Record<string, unknown>;
}

function isParamArray(value: unknown): value is Array<string | number> {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === 'string' || typeof item === 'number')
  );
}

function collectQueryParams(
  args: Record<string, unknown>,
  endpoint: EndpointDef,
): QueryParams | undefined {
  const params: QueryParams = {};
  let hasParams = false;
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      isParamArray(value)
    ) {
      params[key] = value;
      hasParams = true;
      continue;
    }
    const what = Array.isArray(value)
      ? 'an array with non-primitive items'
      : typeof value === 'object'
        ? 'a nested object'
        : `a ${typeof value}`;
    throw new Error(
      `${endpoint.method} ${endpoint.path}: input field "${key}" is ${what} — it cannot ` +
        'travel as a query parameter. GET / DELETE input must be flat (string / number / ' +
        'boolean, or an array of string / number); flatten the field or move the ' +
        'operation to a body verb (POST).',
    );
  }
  return hasParams ? params : undefined;
}

function hasStringKeys<K extends string>(
  args: Record<string, unknown>,
  keys: readonly K[],
): args is Record<string, unknown> & PathPrefixArgs<K> {
  for (const key of keys) {
    if (typeof args[key] !== 'string') return false;
  }
  return true;
}

function resolvePathPrefix<K extends string>(
  config: ContractClientConfig<K> | undefined,
  args: Record<string, unknown>,
): string {
  if (!config?.pathPrefix) return '';
  if (typeof config.pathPrefix === 'string') return config.pathPrefix;

  const keys = config.stripPrefixKeys ?? [];
  if (!hasStringKeys(args, keys)) {
    const missing = keys.find((key) => typeof args[key] !== 'string');
    throw new Error(`Missing path prefix key: ${missing}`);
  }
  return config.pathPrefix(args);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Compile the same contract/prefix structure used by the request planner into a pathname matcher. */
export function createClientRouteMatcher<K extends string>(
  endpoint: EndpointDef,
  contractPrefix: string,
  config?: ContractClientConfig<K>,
): (pathname: string) => boolean {
  if (
    typeof config?.pathPrefix === 'function' &&
    (!config.stripPrefixKeys || config.stripPrefixKeys.length === 0)
  ) {
    throw new Error('Dynamic pathPrefix matchers require stripPrefixKeys');
  }
  const markerByKey: Record<string, string> = {};
  for (const [index, key] of (config?.stripPrefixKeys ?? []).entries()) {
    markerByKey[key] = `__stitch_scope_${index}__`;
  }
  const pathPrefix = resolvePathPrefix(config, markerByKey);
  const route = [pathPrefix, contractPrefix, endpoint.path === '/' ? '' : endpoint.path]
    .filter(Boolean)
    .join('/');
  const patternSegments = route.split('/').filter(Boolean);
  const wildcard = patternSegments.at(-1)?.startsWith('*') === true;
  const fixedCount = wildcard ? patternSegments.length - 1 : patternSegments.length;
  const markers = Object.values(markerByKey);

  return (pathname: string): boolean => {
    const actualSegments = pathname.split('/').filter(Boolean).map(decodePathSegment);
    if (wildcard ? actualSegments.length < fixedCount : actualSegments.length !== fixedCount) {
      return false;
    }
    for (let index = 0; index < fixedCount; index += 1) {
      const pattern = patternSegments[index];
      const actual = actualSegments[index];
      if (!pattern || actual === undefined) return false;
      if (pattern.startsWith(':')) continue;
      let source = escapeRegex(pattern);
      for (const marker of markers) {
        source = source.replaceAll(escapeRegex(marker), '[^/]+');
      }
      if (!new RegExp(`^${source}$`).test(actual)) return false;
    }
    return true;
  };
}

function extractParamNames(path: string): string[] {
  const matches = path.match(/:(\w+)/g);
  const names = matches ? matches.map((match) => match.slice(1)) : [];
  const wildcard = parseTrailingWildcard(path);
  if (wildcard) names.push(wildcard.name);
  return names;
}

function fillPathParams(path: string, args: Record<string, unknown>): string {
  const wildcard = parseTrailingWildcard(path);
  let filled = path.replace(/:(\w+)/g, (_, key) => {
    const value = args[key];
    if (value === undefined || value === null) {
      throw new Error(`Missing path param: ${key}`);
    }
    return encodeURIComponent(String(value));
  });
  if (!wildcard) return filled;

  const wildcardValue = args[wildcard.name];
  if (wildcardValue === undefined || wildcardValue === null) {
    throw new Error(`Missing path param: ${wildcard.name}`);
  }
  const remainder = String(wildcardValue)
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  filled = `${filled.slice(0, -(wildcard.name.length + 1))}${remainder}`;
  return filled;
}

function stripConsumedArgs(
  args: Record<string, unknown>,
  path: string,
  scopeKeys: readonly string[],
): Record<string, unknown> {
  const consumed = new Set(scopeKeys);
  for (const name of extractParamNames(path)) consumed.add(name);

  const remaining: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (!consumed.has(key) && value !== undefined) remaining[key] = value;
  }
  return remaining;
}

function appendQuery(relativeUrl: string, params: QueryParams | undefined): string {
  if (!params) return relativeUrl;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      for (const item of value) search.append(key, String(item));
    } else {
      search.set(key, String(value));
    }
  }
  return search.size > 0 ? `${relativeUrl}?${search}` : relativeUrl;
}

/** Plan the complete request URL and body/form fields without executing I/O. */
export function planClientRequest<K extends string>(
  endpoint: EndpointDef,
  contractPrefix: string,
  args: Record<string, unknown>,
  config?: ContractClientConfig<K>,
): ClientRequestPlan {
  let pathPrefix = resolvePathPrefix(config, args);
  if (pathPrefix && !pathPrefix.endsWith('/')) pathPrefix += '/';
  if (pathPrefix.startsWith('/')) pathPrefix = pathPrefix.slice(1);

  const endpointPath = endpoint.path === '/' ? '' : endpoint.path;
  let relativeUrl = fillPathParams(`${pathPrefix}${contractPrefix}${endpointPath}`, args);
  if (relativeUrl.endsWith('/')) relativeUrl = relativeUrl.slice(0, -1);

  const remainingArgs = stripConsumedArgs(args, endpoint.path, config?.stripPrefixKeys ?? []);
  if (inputIsQuery(endpoint.method)) {
    relativeUrl = appendQuery(relativeUrl, collectQueryParams(remainingArgs, endpoint));
  }

  return { relativeUrl, remainingArgs };
}

/** Join a configured absolute or relative base with a planner-owned relative URL. */
export function joinClientBaseUrl(baseUrl: string, relativeUrl: string): string {
  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const path = relativeUrl.startsWith('/') ? relativeUrl : `/${relativeUrl}`;
  return `${base}${path}`;
}
