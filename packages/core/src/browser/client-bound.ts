/**
 * Arguments a client was given once, for every call: which of them one endpoint takes, and
 * whether they are all the arguments it has.
 */
import type { EndpointDef } from '../contract/define';
import { inputIsQuery } from '../internal/http-input';
import { isRecord } from '../internal/typed';
import type { ContractClientConfig } from './client';
import { endpointHasArguments } from './client-arguments';
import { routeParamNames } from './client-url';

const WRAPPERS = new Set([
  'optional',
  'nullable',
  'default',
  'prefault',
  'nonoptional',
  'readonly',
  'catch',
]);

/**
 * Add the fields a schema declares to `into`; `false` when the schema can take a field it does
 * not name (a record, a catch-all object) or is a kind this reader does not open.
 *
 * Read by shape, not by `instanceof`: the browser client imports no Zod value.
 */
function collectDeclaredFields(schema: unknown, into: Set<string>): boolean {
  if (!isRecord(schema)) return false;
  const def = isRecord(schema.def) ? schema.def : {};
  if (isRecord(schema.shape)) {
    for (const key of Object.keys(schema.shape)) into.add(key);
    return def.catchall === undefined;
  }
  if (def.type === 'union' && Array.isArray(def.options)) {
    let closed = true;
    for (const option of def.options) closed = collectDeclaredFields(option, into) && closed;
    return closed;
  }
  if (def.type === 'intersection') {
    const left = collectDeclaredFields(def.left, into);
    return collectDeclaredFields(def.right, into) && left;
  }
  if (def.type === 'pipe') return collectDeclaredFields(def.in, into);
  if (typeof def.type === 'string' && WRAPPERS.has(def.type))
    return collectDeclaredFields(def.innerType, into);
  return false;
}

/** What a client's bound arguments mean for one endpoint. */
export interface BoundEndpointArguments {
  /** The bound values this endpoint takes: a path parameter, a prefix key or a declared field. */
  readonly values: Readonly<Record<string, unknown>>;
  /** Every argument the endpoint has is bound, so its method is called with none. */
  readonly complete: boolean;
}

/**
 * Select the bound arguments of one endpoint's request, or of its URL alone. A bound key the endpoint does not declare is left
 * out: it would otherwise travel as a query parameter or body field the operation never named.
 */
export function boundEndpointArguments<K extends string>(
  endpoint: EndpointDef,
  contractPrefix: string,
  config: ContractClientConfig<K> | undefined,
  surface: 'request' | 'url' = 'request',
): BoundEndpointArguments {
  const scopeKeys = config?.stripPrefixKeys ?? [];
  const declared = new Set<string>(scopeKeys);
  const staticPrefix = typeof config?.pathPrefix === 'string' ? config.pathPrefix : '';
  for (const name of routeParamNames(`${staticPrefix}/${contractPrefix}${endpoint.path}`))
    declared.add(name);
  let closed = true;
  if (endpoint.params) closed = collectDeclaredFields(endpoint.params, declared) && closed;
  // A URL carries the input of a query verb only; a body verb's fields and files are not part
  // of it, so a URL builder neither takes nor binds them.
  if (surface === 'request' || inputIsQuery(endpoint.method)) {
    if (endpoint.input) closed = collectDeclaredFields(endpoint.input, declared) && closed;
  }
  if (surface === 'request')
    for (const name of Object.keys(endpoint.multipart?.files ?? {})) declared.add(name);

  const bound = config?.bound ?? {};
  const values: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(bound)) {
    if (value !== undefined && declared.has(key)) values[key] = value;
  }
  const takesArguments = endpointHasArguments(endpoint) || scopeKeys.length > 0;
  // With nothing bound the call shape is the endpoint's own, whatever its schemas declare: an
  // endpoint with an empty input object still takes its argument.
  const complete =
    !takesArguments ||
    (Object.keys(values).length > 0 &&
      closed &&
      [...declared].every((key) => Object.hasOwn(values, key)));
  return { values, complete };
}
