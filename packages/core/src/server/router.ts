/**
 * Route matching — contract route table (build / match / validate) and the
 * raw-route matcher. The handler pipeline lives in `create.ts`.
 */
import { parseTrailingWildcard } from '../internal/route-pattern';
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

/** Compiled route table — HTTP method → entries (param routes sorted last). */
export type RouteMap = Map<string, RouteEntry[]>;

export interface RouteMatch {
  method: MethodDef;
  pathParams: Record<string, string>;
  groupHooks?: LifecycleHooks;
}

function joinPath(...parts: string[]): string {
  const joined = parts
    .filter(Boolean)
    .map((part) => part.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
  return `/${joined}`;
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
      params[pattern.slice(1)] = decodeURIComponent(actual);
    } else if (pattern !== actual) {
      return null;
    }
  }
  if (wildcardName) {
    params[wildcardName] = requestSegments
      .slice(prefixLength)
      .map(decodeURIComponent)
      .join('/');
  }
  return params;
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

      const servicePath = joinPath(
        '/',
        service.prefix,
        method.path === '/' ? '' : method.path,
      );
      const fullPath = prefix ? joinPath(prefix, servicePath) : servicePath;
      const segments = fullPath.split('/').filter(Boolean);

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

  const requestSegments = pathname.split('/').filter(Boolean);

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
  const requestSegments = pathname.split('/').filter(Boolean);
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
      const routeSegs = route.path.split('/').filter(Boolean);
      const pathSegs = pathname.split('/').filter(Boolean);
      const params = matchSegments(routeSegs, pathSegs);
      if (params) return { route, params };
      continue;
    }

    // `:param` segments — matched and passed to the handler.
    if (route.path.includes('/:')) {
      const routeSegs = route.path.split('/').filter(Boolean);
      const pathSegs = pathname.split('/').filter(Boolean);
      const params = matchSegments(routeSegs, pathSegs);
      if (params) return { route, params };
      continue;
    }

    if (route.path === pathname) return { route, params: {} };
  }
  return null;
}

/** Validate raw route parameter and named-wildcard structure once at startup. */
export function validateRawRoutes<TServer>(rawRoutes: RawRoute<TServer>[] | undefined): void {
  for (const route of rawRoutes ?? []) parseTrailingWildcard(route.path);
}
