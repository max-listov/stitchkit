const PARAM_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Join route parts into one absolute path, tolerating stray slashes on either
 * side of every part.
 *
 * One home rather than three. The router, the OpenAPI generator and the surface
 * manifest each carried a byte-identical copy, and a route path that all three
 * must agree on is exactly the thing that must not be computed three ways.
 */
export function joinRoutePath(...parts: Array<string | undefined>): string {
  const joined = parts
    .filter((part): part is string => Boolean(part))
    .map((part) => part.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
  return `/${joined}`;
}

export interface TrailingWildcard {
  name: string;
  segmentIndex: number;
}

/** Parse and validate the route's single named terminal wildcard, if present. */
export function parseTrailingWildcard(path: string): TrailingWildcard | null {
  const segments = path.split('/').filter(Boolean);
  const paramNames = new Set<string>();
  let wildcard: TrailingWildcard | null = null;

  for (const [segmentIndex, segment] of segments.entries()) {
    if (segment.startsWith(':')) {
      const name = segment.slice(1);
      if (!PARAM_IDENTIFIER.test(name)) {
        throw new Error(`Invalid route parameter name "${name}" in path "${path}"`);
      }
      if (paramNames.has(name)) {
        throw new Error(`Duplicate route parameter name "${name}" in path "${path}"`);
      }
      paramNames.add(name);
      continue;
    }
    if (!segment.startsWith('*')) {
      if (segment.includes('*')) {
        throw new Error(`Wildcard must occupy its own segment in path "${path}"`);
      }
      continue;
    }

    const name = segment.slice(1);
    if (!PARAM_IDENTIFIER.test(name)) {
      throw new Error(
        `Trailing wildcard in path "${path}" must be named, for example "/*filePath"`,
      );
    }
    if (segmentIndex !== segments.length - 1) {
      throw new Error(`Wildcard "*${name}" must be the final segment in path "${path}"`);
    }
    if (wildcard) {
      throw new Error(`Path "${path}" contains more than one wildcard`);
    }
    if (paramNames.has(name)) {
      throw new Error(`Duplicate route parameter name "${name}" in path "${path}"`);
    }
    wildcard = { name, segmentIndex };
  }

  return wildcard;
}
