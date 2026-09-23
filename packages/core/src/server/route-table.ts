/**
 * The handler's route table, compiled and checked once at construction: group
 * mounting, route validation and the startup report of shadowed routes.
 * Matching itself lives in `router.ts`.
 */

import {
  buildRouteMap,
  findShadowedRoutes,
  type NormalizedGroup,
  type RouteMap,
  validateRawRoutes,
  validateRoutes,
} from './router';
import type { HandlerConfig } from './types';

export function compileRouteTable<TServer>(
  config: HandlerConfig<TServer>,
  warn: (line: string) => void,
): RouteMap {
  // A route group cannot carry `onRequest`: it runs before routing, and the
  // group is only known after it. The type refuses it (`RouteGroupHooks`); this
  // gives a JavaScript consumer the same answer at startup rather than a hook
  // that typechecks in an editor, runs, and fences nothing.
  for (const group of config.groups ?? []) {
    if (group.hooks && 'onRequest' in group.hooks) {
      throw new Error(
        '[stitchkit] a route group cannot declare `onRequest` — it runs before routing, so the group it belongs to is not known yet and the hook would never be dispatched. Refuse before dispatch with the server-level `hooks.onRequest`, or gate the group with its `authorize`, which runs once the endpoint is known.',
      );
    }
  }
  const routeMap = buildRouteMap(normalizeGroups(config));
  validateRoutes(routeMap);
  validateRawRoutes(config.rawRoutes);

  // Raw routes match first, so one covering a contract path makes that endpoint
  // dead — and takes its auth gate with it. Reported at startup because the
  // silent version of this is the failure raw-response endpoints exist to
  // prevent: move a download into the contract for the gate, forget the old raw
  // route, keep serving the bytes ungated. → ADR 0038.
  for (const shadow of findShadowedRoutes(routeMap, config.rawRoutes)) {
    const gate = shadow.scope && shadow.scope !== 'public' ? ` (scope "${shadow.scope}")` : '';
    const line =
      `[stitchkit] raw route ${shadow.rawRoute} shadows contract route ${shadow.pattern}` +
      ` → ${shadow.endpoint}${gate} will never run, and its hooks never apply`;
    warn(line);
  }
  return routeMap;
}

// ─── Group normalization ─────────────────────────────

function normalizeGroups<TServer>(config: HandlerConfig<TServer>): NormalizedGroup[] {
  const result: NormalizedGroup[] = [];

  if (config.services) {
    for (const service of config.services) {
      // `scope → prefix` mapping: a scoped service mounts under its prefix, an
      // unmapped one mounts flat. Explicit `groups` below are unaffected.
      const prefix = config.scopePrefixes?.[service.scope] ?? '';
      result.push({ prefix, service });
    }
  }

  if (config.groups) {
    for (const group of config.groups) {
      for (const service of group.services) {
        result.push({ prefix: group.pathPrefix ?? '', service, hooks: group.hooks });
      }
    }
  }

  return result;
}
