/**
 * Route matching — contract route table (build / match / validate) and the
 * raw-route matcher. The handler pipeline lives in `create.ts`.
 */
import { joinRoutePath, parseTrailingWildcard } from '../internal/route-pattern';
import type { LifecycleHooks, MethodDef, RawRoute, ServiceDef } from './types';

/** A service mounted under a path prefix, carrying optional group hooks. */
export interface NormalizedGroup {
  prefix: string;
  service: ServiceDef;
  hooks?: LifecycleHooks;
}

interface RouteEntry {
  method: MethodDef;
  pattern: string;
  segments: string[];
  groupHooks?: LifecycleHooks;
}

type RouteShapeSegment =
  | { kind: 'static'; value: string }
  | { kind: 'param' }
  | { kind: 'wildcard' };

interface RawRouteShape {
  segments: RouteShapeSegment[];
  signature: string;
  wildcard: boolean;
}

/** Compiled route table — HTTP method → entries (param routes sorted last). */
export type RouteMap = Map<string, RouteEntry[]>;

export interface RouteMatch {
  method: MethodDef;
  pathParams: Record<string, string>;
  groupHooks?: LifecycleHooks;
}

/** One segmentation rule shared by contract matching, raw matching and validation. */
function routeSegments(path: string): string[] {
  return path.split('/').filter(Boolean);
}

function rawRouteShape(path: string): RawRouteShape {
  parseTrailingWildcard(path);
  const segments = routeSegments(path).map<RouteShapeSegment>((segment) => {
    if (segment.startsWith(':')) return { kind: 'param' };
    if (segment.startsWith('*')) return { kind: 'wildcard' };
    return { kind: 'static', value: segment };
  });
  return {
    segments,
    signature: segments
      .map((segment) => (segment.kind === 'static' ? segment.value : `:${segment.kind}`))
      .join('/'),
    wildcard: segments.at(-1)?.kind === 'wildcard',
  };
}

function segmentCovers(earlier: RouteShapeSegment, later: RouteShapeSegment): boolean {
  if (earlier.kind === 'param') return later.kind !== 'wildcard';
  if (earlier.kind === 'wildcard') return true;
  return later.kind === 'static' && earlier.value === later.value;
}

/** Whether every path accepted by `later` is already accepted by `earlier`. */
function routeShapeCovers(earlier: RawRouteShape, later: RawRouteShape): boolean {
  const earlierPrefixLength = earlier.wildcard
    ? earlier.segments.length - 1
    : earlier.segments.length;
  const laterPrefixLength = later.wildcard ? later.segments.length - 1 : later.segments.length;

  if (earlier.wildcard) {
    if (earlierPrefixLength > laterPrefixLength) return false;
  } else {
    if (later.wildcard || earlierPrefixLength !== laterPrefixLength) return false;
  }

  for (let index = 0; index < earlierPrefixLength; index++) {
    const earlierSegment = earlier.segments[index];
    const laterSegment = later.segments[index];
    if (!earlierSegment || !laterSegment || !segmentCovers(earlierSegment, laterSegment)) {
      return false;
    }
  }
  return true;
}

/**
 * Match request path segments against a route's pattern segments. A `:param`
 * segment matches any value and is collected; a static segment must be equal.
 * A terminal `*name` consumes zero or more remaining segments under that name.
 * Returns the collected path params, or `null` when the route does not match.
 */
function matchSegments(
  patternSegments: string[],
  requestSegments: string[],
): Record<string, string> | null {
  const wildcardSegment = patternSegments.at(-1);
  const wildcardName = wildcardSegment?.startsWith('*') ? wildcardSegment.slice(1) : null;
  const prefixLength = wildcardName ? patternSegments.length - 1 : patternSegments.length;
  if (wildcardName) {
    if (requestSegments.length < prefixLength) return null;
  } else if (patternSegments.length !== requestSegments.length) {
    return null;
  }
  const params: Record<string, string> = {};
  for (const [i, pattern] of patternSegments.slice(0, prefixLength).entries()) {
    const actual = requestSegments[i];
    if (actual === undefined) return null;
    if (pattern.startsWith(':')) {
      const decoded = decodeSegment(actual);
      if (decoded === null) return null;
      params[pattern.slice(1)] = decoded;
    } else if (pattern !== actual) {
      return null;
    }
  }
  if (wildcardName) {
    const decoded = requestSegments.slice(prefixLength).map(decodeSegment);
    if (decoded.some((segment) => segment === null)) return null;
    params[wildcardName] = decoded.join('/');
  }
  return params;
}

/**
 * A segment whose percent-encoding is malformed (`%E0%A4%A`, `%ZZ`) names no
 * resource: it fails to match instead of escaping the router as a bare
 * `URIError`, so the request ends in the ordinary 404 envelope with its
 * request id, CORS headers and audit event.
 */
function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/** Static routes win over params, and params win over a terminal catch-all. */
function segmentRank(segment: string | undefined): number {
  if (segment?.startsWith('*')) return 2;
  if (segment?.startsWith(':')) return 1;
  return 0;
}

// ─── Contract routes ─────────────────────────────────

export function buildRouteMap(groups: NormalizedGroup[]): RouteMap {
  const map: RouteMap = new Map();

  for (const { prefix, service, hooks } of groups) {
    for (const [, method] of Object.entries(service.methods)) {
      if (method.expose && !method.expose.includes('HTTP')) continue;

      const servicePath = joinRoutePath(
        '/',
        service.prefix,
        method.path === '/' ? '' : method.path,
      );
      const fullPath = prefix ? joinRoutePath(prefix, servicePath) : servicePath;
      const segments = routeSegments(fullPath);

      const entries = map.get(method.method) ?? [];
      entries.push({ method, pattern: fullPath, segments, groupHooks: hooks });
      map.set(method.method, entries);
    }
  }

  // Static segments before `:param`, terminal wildcard last — exact matches win.
  for (const [, entries] of map) {
    entries.sort((a, b) => {
      const len = Math.min(a.segments.length, b.segments.length);
      for (let i = 0; i < len; i++) {
        const rankDifference = segmentRank(a.segments[i]) - segmentRank(b.segments[i]);
        if (rankDifference !== 0) return rankDifference;
      }
      return a.segments.length - b.segments.length;
    });
  }

  return map;
}

export function matchRoute(
  routeMap: RouteMap,
  httpMethod: string,
  pathname: string,
): RouteMatch | null {
  const entries = routeMap.get(httpMethod);
  if (!entries) return null;

  const requestSegments = routeSegments(pathname);

  for (const entry of entries) {
    const pathParams = matchSegments(entry.segments, requestSegments);
    if (pathParams) {
      return {
        method: entry.method,
        pathParams,
        groupHooks: entry.groupHooks,
      };
    }
  }

  return null;
}

/**
 * HTTP methods that have a route matching `pathname` — for a `405` `Allow`
 * header when the path exists but not under the requested method.
 */
export function allowedMethods(routeMap: RouteMap, pathname: string): string[] {
  const requestSegments = routeSegments(pathname);
  const methods: string[] = [];

  for (const [method, entries] of routeMap) {
    for (const entry of entries) {
      if (matchSegments(entry.segments, requestSegments)) {
        methods.push(method);
        break;
      }
    }
  }

  return methods;
}

/** Startup guard — throws when two routes collapse to the same shape. */
export function validateRoutes(routeMap: RouteMap): void {
  for (const [method, entries] of routeMap) {
    const seen = new Map<string, string>();
    for (const entry of entries) {
      parseTrailingWildcard(entry.pattern);
      const normalized = entry.segments
        .map((s) => (s.startsWith(':') ? ':param' : s.startsWith('*') ? '*wildcard' : s))
        .join('/');
      const key = `${method} /${normalized}`;
      const existing = seen.get(key);
      if (existing) {
        throw new Error(
          `Duplicate route: ${method} ${entry.pattern} conflicts with ${existing}`,
        );
      }
      seen.set(key, entry.pattern);
    }
  }
}

/** One contract route that a raw route matches first, so the contract route is dead. */
export interface ShadowedRoute {
  /** The contract route pattern, e.g. `GET /documents/:id/pdf`. */
  pattern: string;
  /** `serviceName.key` of the endpoint that will never run. */
  endpoint: string;
  /** The raw route that wins, e.g. `GET /documents/:id/pdf` or `ALL /files/*`. */
  rawRoute: string;
  /** The shadowed endpoint's scope — the auth gate the raw route bypasses. */
  scope?: string;
}

/**
 * Startup diagnostic — raw routes are matched **before** contract routes, so a
 * raw route covering a contract path silently wins and the endpoint never runs.
 *
 * This matters most for the migration raw-response endpoints exist to enable
 * (→ ADR 0038): move a download out of `rawRoutes` into the contract to gain the
 * auth gate, forget to delete the old raw route, and the bytes keep being served
 * ungated — with no error anywhere. Reported, not thrown: an overlapping
 * wildcard (a SPA fallback) can be deliberate, and refusing to boot a working
 * app would be the worse failure.
 *
 * Detection runs the **real** `matchRawRoute` against a concrete probe path
 * built from each contract route, so it can never disagree with what the
 * dispatcher actually does.
 */
export function findShadowedRoutes<TServer>(
  routeMap: RouteMap,
  rawRoutes: RawRoute<TServer>[] | undefined,
): ShadowedRoute[] {
  if (!rawRoutes || rawRoutes.length === 0) return [];
  const shadowed: ShadowedRoute[] = [];
  for (const [httpMethod, entries] of routeMap) {
    for (const entry of entries) {
      // `:id` → a literal that cannot collide with a real path segment, so the
      // probe tests the route *shape* rather than one lucky value.
      const probe = `/${entry.segments
        .map((segment) => {
          if (segment.startsWith(':')) return '__param__';
          if (segment.startsWith('*')) return '__wildcard__';
          return segment;
        })
        .join('/')}`;
      const match = matchRawRoute(rawRoutes, httpMethod, probe);
      if (!match) continue;
      shadowed.push({
        pattern: `${httpMethod} ${entry.pattern}`,
        endpoint: `${entry.method.serviceName}.${entry.method.key}`,
        rawRoute: `${match.route.method} ${match.route.path}`,
        scope: entry.method.scope,
      });
    }
  }
  return shadowed;
}

// ─── Raw routes ──────────────────────────────────────

export function matchRawRoute<TServer>(
  rawRoutes: RawRoute<TServer>[],
  httpMethod: string,
  pathname: string,
): { route: RawRoute<TServer>; params: Record<string, string> } | null {
  for (const route of rawRoutes) {
    if (route.method !== 'ALL' && route.method !== httpMethod) continue;

    // A named trailing wildcard shares the contract router's segment semantics.
    if (parseTrailingWildcard(route.path)) {
      const routeSegs = routeSegments(route.path);
      const pathSegs = routeSegments(pathname);
      const params = matchSegments(routeSegs, pathSegs);
      if (params) return { route, params };
      continue;
    }

    // `:param` segments — matched and passed to the handler.
    if (route.path.includes('/:')) {
      const routeSegs = routeSegments(route.path);
      const pathSegs = routeSegments(pathname);
      const params = matchSegments(routeSegs, pathSegs);
      if (params) return { route, params };
      continue;
    }

    if (route.path === pathname) return { route, params: {} };
  }
  return null;
}

/**
 * Validate raw route structure and reject routes that the ordered matcher can
 * prove ambiguous or unreachable. Partial overlaps remain legal.
 */
export function validateRawRoutes<TServer>(rawRoutes: RawRoute<TServer>[] | undefined): void {
  const routes = rawRoutes ?? [];
  for (const route of routes) {
    if (route.serviceName !== undefined && route.serviceName.trim().length === 0) {
      throw new Error(`Raw route ${route.method} ${route.path} has an empty serviceName`);
    }
    if (route.action !== undefined && route.action.trim().length === 0) {
      throw new Error(`Raw route ${route.method} ${route.path} has an empty action`);
    }
    if (route.action !== undefined && route.serviceName === undefined) {
      throw new Error(
        `Raw route ${route.method} ${route.path} declares action without serviceName`,
      );
    }
  }
  const shapes = routes.map((route) => rawRouteShape(route.path));
  const conflicts: string[] = [];

  for (const [laterIndex, later] of routes.entries()) {
    const laterShape = shapes[laterIndex];
    if (!laterShape) continue;

    for (let earlierIndex = 0; earlierIndex < laterIndex; earlierIndex++) {
      const earlier = routes[earlierIndex];
      const earlierShape = shapes[earlierIndex];
      if (!earlier || !earlierShape) continue;

      if (earlier.method === later.method && earlier.path === later.path) {
        conflicts.push(
          `${later.method} ${later.path} duplicates earlier ${earlier.method} ${earlier.path}`,
        );
        continue;
      }

      if (earlier.method === later.method && earlierShape.signature === laterShape.signature) {
        conflicts.push(
          `${later.method} ${later.path} has the same parameter shape as earlier ${earlier.method} ${earlier.path}`,
        );
        continue;
      }

      const methodCovered = earlier.method === 'ALL' || earlier.method === later.method;
      if (methodCovered && routeShapeCovers(earlierShape, laterShape)) {
        conflicts.push(
          `${later.method} ${later.path} is unreachable because earlier ${earlier.method} ${earlier.path} matches every request it could receive`,
        );
      }
    }
  }

  if (conflicts.length > 0) {
    throw new Error(`[stitchkit] conflicting raw routes:\n- ${conflicts.join('\n- ')}`);
  }
}
