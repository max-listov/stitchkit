import { type ZodType, z } from 'zod';
import { isUnsafeKey } from './safe-json';

const PARAM_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

type RouteSegmentKey<TSegment extends string> = TSegment extends `:${infer TName}`
  ? TName
  : TSegment extends `*${infer TName}`
    ? TName
    : never;

type RouteParamKeys<TPath extends string> = TPath extends `${infer THead}/${infer TTail}`
  ? RouteSegmentKey<THead> | RouteParamKeys<TTail>
  : RouteSegmentKey<TPath>;

/** String params named by a route literal (`/:userId/*filePath`). */
export type PathParams<TPath extends string> = string extends TPath
  ? Record<string, string>
  : { [TKey in RouteParamKeys<TPath>]: string };

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

export interface RouteParameter {
  name: string;
  kind: 'segment' | 'wildcard';
  segmentIndex: number;
}

/** Parse and validate every named parameter in one route pattern. */
export function parseRoutePattern(path: string): readonly RouteParameter[] {
  const segments = path.split('/').filter(Boolean);
  const parameters: RouteParameter[] = [];
  const names = new Set<string>();

  for (const [segmentIndex, segment] of segments.entries()) {
    const marker = segment.at(0);
    if (marker !== ':' && marker !== '*') {
      if (segment.includes('*')) {
        throw new Error(`Wildcard must occupy its own segment in path "${path}"`);
      }
      continue;
    }

    const name = segment.slice(1);
    if (marker === '*' && name === '') {
      throw new Error(
        `Trailing wildcard in path "${path}" must be named, for example "/*filePath"`,
      );
    }
    if (!PARAM_IDENTIFIER.test(name) || isUnsafeKey(name)) {
      const label = marker === '*' ? 'wildcard' : 'route parameter';
      throw new Error(`Invalid ${label} name "${name}" in path "${path}"`);
    }
    if (names.has(name)) {
      throw new Error(`Duplicate route parameter name "${name}" in path "${path}"`);
    }
    if (marker === '*' && segmentIndex !== segments.length - 1) {
      throw new Error(`Wildcard "*${name}" must be the final segment in path "${path}"`);
    }

    names.add(name);
    parameters.push({
      name,
      kind: marker === '*' ? 'wildcard' : 'segment',
      segmentIndex,
    });
  }

  return parameters;
}

/**
 * Resolve the runtime params schema from the same parser that owns route
 * matching. An explicit schema keeps its coercion/validation, but must cover
 * every name carried by the path.
 */
export function resolveRouteParamsSchema(
  path: string,
  schema?: ZodType<unknown>,
): ZodType<unknown> | undefined {
  const parameters = parseRoutePattern(path);
  if (parameters.length === 0) return schema;

  if (!schema) {
    const shape: Record<string, z.ZodString> = {};
    for (const parameter of parameters) shape[parameter.name] = z.string();
    return z.object(shape);
  }

  // Coverage is read off the input JSON Schema with unrepresentable members
  // allowed through — a `z.coerce.date()` field is a fine path param and has
  // no JSON Schema form; only the property *names* matter here.
  const jsonSchema = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
  const properties = jsonSchema.properties;
  if (!properties) {
    throw new Error(
      `Route params schema for path "${path}" must be an object schema with a property per path field`,
    );
  }
  for (const parameter of parameters) {
    if (!(parameter.name in properties)) {
      const kind = parameter.kind === 'wildcard' ? 'wildcard' : 'path';
      throw new Error(
        `Route params schema for path "${path}" is missing ${kind} field "${parameter.name}"`,
      );
    }
  }
  // A required field the path never supplies would fail every request at
  // validation; an optional one is harmless and left alone.
  const names = new Set(parameters.map((parameter) => parameter.name));
  const required = Array.isArray(jsonSchema.required) ? jsonSchema.required : [];
  for (const field of required) {
    if (typeof field === 'string' && !names.has(field)) {
      throw new Error(
        `Route params schema for path "${path}" requires field "${field}" that the path does not carry`,
      );
    }
  }
  return schema;
}

/** Parse and validate the route's single named terminal wildcard, if present. */
export function parseTrailingWildcard(path: string): TrailingWildcard | null {
  const wildcard = parseRoutePattern(path).find((parameter) => parameter.kind === 'wildcard');
  return wildcard ? { name: wildcard.name, segmentIndex: wildcard.segmentIndex } : null;
}
