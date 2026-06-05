/**
 * Route matching — contract route table (build / match / validate) and the
 * raw-route matcher. The handler pipeline lives in `create.ts`.
 */
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isWithinDir } from '../internal/within-dir';
import { mimeForPath } from './mime';
import type { LifecycleHooks, MethodDef, RawRoute, ServiceDef } from './types';

/** A service mounted under a path prefix, carrying optional group hooks. */
export interface NormalizedGroup {
  prefix: string;
  service: ServiceDef;
  hooks?: LifecycleHooks;
}

interface RouteEntry {
  method: MethodDef;
  service: ServiceDef;
  pattern: string;
  segments: string[];
  groupHooks?: LifecycleHooks;
}

/** Compiled route table — HTTP method → entries (param routes sorted last). */
export type RouteMap = Map<string, RouteEntry[]>;

export interface RouteMatch {
  method: MethodDef;
  service: ServiceDef;
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
 * Returns the collected path params, or `null` when the route does not match
 * (segment count differs, or a static segment mismatched).
 */
function matchSegments(
  patternSegments: string[],
  requestSegments: string[],
): Record<string, string> | null {
  if (patternSegments.length !== requestSegments.length) return null;
  const params: Record<string, string> = {};
  for (const [i, pattern] of patternSegments.entries()) {
    const actual = requestSegments[i];
    if (actual === undefined) return null;
    if (pattern.startsWith(':')) {
      params[pattern.slice(1)] = decodeURIComponent(actual);
    } else if (pattern !== actual) {
      return null;
    }
  }
  return params;
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
      entries.push({ method, service, pattern: fullPath, segments, groupHooks: hooks });
      map.set(method.method, entries);
    }
  }

  // Static segments before `:param` segments — exact matches win.
  for (const [, entries] of map) {
    entries.sort((a, b) => {
      const len = Math.min(a.segments.length, b.segments.length);
      for (let i = 0; i < len; i++) {
        const aIsParam = a.segments[i]?.startsWith(':');
        const bIsParam = b.segments[i]?.startsWith(':');
        if (aIsParam !== bIsParam) return aIsParam ? 1 : -1;
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
        service: entry.service,
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
      const normalized = entry.segments
        .map((s) => (s.startsWith(':') ? ':param' : s))
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

// ─── Raw routes ──────────────────────────────────────

export function matchRawRoute(
  rawRoutes: RawRoute[],
  httpMethod: string,
  pathname: string,
): { route: RawRoute; params: Record<string, string> } | null {
  for (const route of rawRoutes) {
    if (route.method !== 'ALL' && route.method !== httpMethod) continue;

    // Trailing `/*` — prefix wildcard.
    if (route.path.endsWith('/*')) {
      const prefix = route.path.slice(0, -2);
      if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
        return { route, params: {} };
      }
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

/**
 * Build a `RawRoute` that serves files from `dir` under `prefix`. Basic by
 * design — no Range, no conditional requests, reads the whole file into memory;
 * for media seeking / caching use `serveFile`, or put a CDN in front. Rejects
 * path traversal (including the percent-encoded form); 404 for a missing file.
 * Uses `node:fs`, so it runs on both Bun and Node.
 */
export function staticRoute(prefix: string, dir: string): RawRoute {
  const cleanPrefix = prefix.replace(/\/+$/, '');
  const root = resolve(dir.replace(/\/+$/, ''));
  return {
    method: 'GET',
    path: `${cleanPrefix}/*`,
    handler: async (req: Request): Promise<Response> => {
      const pathname = new URL(req.url).pathname;
      // Decode the path before resolving — so a percent-encoded `..` becomes a
      // real `..` and is caught by the containment check, never slips through.
      let rel: string;
      try {
        rel = decodeURIComponent(pathname.slice(cleanPrefix.length)).replace(/^\/+/, '');
      } catch {
        return new Response('Bad request', { status: 400 });
      }
      const target = resolve(root, rel);
      if (!isWithinDir(root, target)) {
        return new Response('Forbidden', { status: 403 });
      }
      const info = await stat(target).catch(() => null);
      if (!info?.isFile()) {
        return new Response('Not found', { status: 404 });
      }
      const body = await readFile(target);
      return new Response(body, {
        headers: {
          'Content-Type': mimeForPath(target),
          // Never let a browser sniff a served file into an executable type.
          'X-Content-Type-Options': 'nosniff',
        },
      });
    },
  };
}
