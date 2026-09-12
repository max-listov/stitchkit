import { isRecord } from '../../internal/typed';

/** Resolve only local references, with bounded expansion and explicit cycle refusal. */
export function resolveOpenApiDocument(
  document: Record<string, unknown>,
): Record<string, unknown> {
  let nodes = 0;
  const visit = (value: unknown, refs: readonly string[], depth: number): unknown => {
    if (++nodes > 100_000 || depth > 64)
      throw new TypeError('OpenAPI document expansion exceeds its limit');
    if (Array.isArray(value)) return value.map((item) => visit(item, refs, depth + 1));
    if (!isRecord(value)) return value;
    if (typeof value.$ref === 'string') {
      const ref = value.$ref;
      if (!ref.startsWith('#/'))
        throw new TypeError('OpenAPI external references are unsupported');
      if (refs.includes(ref))
        throw new TypeError('OpenAPI recursive references are unsupported');
      let target: unknown = document;
      for (const part of ref
        .slice(2)
        .split('/')
        .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))) {
        if (!isRecord(target) || !Object.hasOwn(target, part))
          throw new TypeError('OpenAPI reference does not resolve');
        target = target[part];
      }
      if (!isRecord(target))
        throw new TypeError('OpenAPI reference must resolve to an object');
      const { $ref: _, ...siblings } = value;
      return visit({ ...target, ...siblings }, [...refs, ref], depth + 1);
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, visit(item, refs, depth + 1)]),
    );
  };
  const result = visit(document, [], 0);
  if (!isRecord(result)) throw new TypeError('OpenAPI document must be an object');
  return result;
}

export function assertOpenApiOperation(
  document: Record<string, unknown>,
  operation: Record<string, unknown>,
  pathItem: Record<string, unknown>,
): void {
  for (const servers of [document.servers, pathItem.servers, operation.servers]) {
    if (
      Array.isArray(servers) &&
      servers.some(
        (server) =>
          isRecord(server) && typeof server.url === 'string' && /[{}]/.test(server.url),
      )
    )
      throw new TypeError('OpenAPI server variables are unsupported');
  }
  const security = operation.security ?? document.security;
  if (
    Array.isArray(security) &&
    security.some((item) => isRecord(item) && Object.keys(item).length > 1)
  )
    throw new TypeError('OpenAPI combined security schemes require a custom tool');
  const body = operation.requestBody;
  if (
    isRecord(body) &&
    (!isRecord(body.content) || !isRecord(body.content['application/json']))
  )
    throw new TypeError('OpenAPI request bodies must declare application/json');
  const names = new Map<string, string>();
  for (const source of [pathItem.parameters, operation.parameters]) {
    if (!Array.isArray(source)) continue;
    for (const parameter of source) {
      if (
        !isRecord(parameter) ||
        typeof parameter.name !== 'string' ||
        typeof parameter.in !== 'string'
      )
        throw new TypeError('Invalid OpenAPI parameter');
      const previous = names.get(parameter.name);
      if (previous && previous !== parameter.in)
        throw new TypeError('OpenAPI parameter names must be unique across locations');
      names.set(parameter.name, parameter.in);
      if (
        isRecord(parameter.schema) &&
        (parameter.schema.type === 'array' || parameter.schema.type === 'object')
      )
        throw new TypeError('OpenAPI structured parameter serialization is unsupported');
      if (parameter.content)
        throw new TypeError('OpenAPI parameter content serialization is unsupported');
    }
  }
}
