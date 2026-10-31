/**
 * `contractEndpointMatchers` answers the same as the algorithm it replaced.
 *
 * The matcher compiles each pattern segment once instead of on every call. That
 * is only a speed-up if no pathname gets a different answer, so the previous
 * per-call algorithm is kept here whole, as an oracle, and both are asked about
 * every path an enumeration of the awkward cases produces: parameters, a
 * trailing wildcard, dynamic-prefix markers inside and beside literals,
 * regular-expression characters in a literal, percent-encoding in the path and
 * in a pattern, a malformed escape, empty segments and a different segment
 * count.
 */
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { contractEndpointMatchers } from '../src/entrypoints';
import { defineContract } from '../src/entrypoints/contract';

const Out = z.object({});

/** The matcher as it was before segments were compiled at creation. */
function legacyMatcher(
  route: string,
  markers: readonly string[],
): (pathname: string) => boolean {
  const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const decode = (value: string): string => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };
  const patternSegments = route.split('/').filter(Boolean);
  const wildcard = patternSegments.at(-1)?.startsWith('*') === true;
  const fixedCount = wildcard ? patternSegments.length - 1 : patternSegments.length;
  return (pathname) => {
    const actualSegments = pathname.split('/').filter(Boolean).map(decode);
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

interface Shape {
  readonly name: string;
  readonly prefix: string;
  readonly path: string;
  readonly keys?: readonly string[];
  readonly pathPrefix?: string | ((scope: Record<string, string>) => string);
}

const SHAPES: readonly Shape[] = [
  { name: 'root', prefix: 'api', path: '/' },
  { name: 'literal', prefix: 'auth', path: '/verify' },
  { name: 'param', prefix: 'users', path: '/:id' },
  { name: 'param then literal', prefix: 'users', path: '/:id/remove' },
  { name: 'wildcard', prefix: 'callbacks', path: '/:provider/*filePath' },
  { name: 'regex characters', prefix: 'v1.0', path: '/(beta)+/a.b' },
  { name: 'non-ascii literal', prefix: 'docs', path: '/✓' },
  { name: 'percent in a literal', prefix: 'docs', path: '/caf%C3%A9' },
  { name: 'static prefix', prefix: 'items', path: '/list', pathPrefix: 'static/prefix' },
  {
    name: 'scope marker',
    prefix: 'areas',
    path: '/search',
    keys: ['tenantId'],
    pathPrefix: ({ tenantId }) => `tenants/${tenantId}`,
  },
  {
    name: 'scope marker with a param',
    prefix: 'areas',
    path: '/:id',
    keys: ['tenantId'],
    pathPrefix: ({ tenantId }) => `tenants/${tenantId}`,
  },
  {
    name: 'scope marker with a wildcard',
    prefix: 'areas',
    path: '/*rest',
    keys: ['tenantId'],
    pathPrefix: ({ tenantId }) => `tenants/${tenantId}`,
  },
  {
    name: 'two scope markers, one beside a literal',
    prefix: 'areas',
    path: '/list',
    keys: ['org', 'project'],
    pathPrefix: ({ org, project }) => `orgs/${org}/p-${project}`,
  },
  {
    name: 'a scoped root',
    prefix: 'areas',
    path: '/',
    keys: ['tenantId'],
    pathPrefix: ({ tenantId }) => `${tenantId}`,
  },
];

/** What a path segment can be at any position, beside what the pattern itself says there. */
const BASE_TOKENS = ['x', 'a%2Fb', '%E2%9C%93', '%zz', '%25', 'caf%C3%A9', 'p-', ''];
/** A long route keeps the awkward tokens and drops the repeats, so the enumeration stays bounded. */
const SHORT_BASE_TOKENS = ['x', 'a%2Fb', '%zz', ''];

function route(shape: Shape): { route: string; markers: string[] } {
  const markers = (shape.keys ?? []).map((_, index) => `__stitch_scope_${index}__`);
  const scope = Object.fromEntries(
    (shape.keys ?? []).map((key, index) => [key, markers[index] ?? '']),
  );
  const prefix =
    typeof shape.pathPrefix === 'function'
      ? shape.pathPrefix(scope)
      : (shape.pathPrefix ?? '');
  const joined = [prefix, shape.prefix, shape.path === '/' ? '' : shape.path]
    .filter(Boolean)
    .join('/');
  return { route: joined, markers };
}

function tokensAt(
  segment: string | undefined,
  markers: readonly string[],
  base: readonly string[],
): string[] {
  const tokens = new Set(base);
  if (segment !== undefined && !segment.startsWith(':') && !segment.startsWith('*')) {
    tokens.add(segment);
    let instantiated = segment;
    for (const marker of markers) instantiated = instantiated.replaceAll(marker, 'x');
    tokens.add(instantiated);
    tokens.add(encodeURIComponent(instantiated));
    tokens.add(instantiated.replaceAll('x', 'a%2Fb'));
  }
  return [...tokens];
}

/** Every path whose segment count is within one of the pattern's, built from the per-position tokens. */
function* corpus(patternSegments: readonly string[], markers: readonly string[]) {
  const count = patternSegments.length;
  const base = count >= 4 ? SHORT_BASE_TOKENS : BASE_TOKENS;
  let serial = 0;
  for (let length = Math.max(0, count - 1); length <= count + 1; length += 1) {
    const positions = Array.from({ length }, (_, index) =>
      tokensAt(patternSegments[index], markers, base),
    );
    const indexes = positions.map(() => 0);
    while (true) {
      const segments = indexes.map(
        (tokenIndex, position) => positions[position]?.[tokenIndex],
      );
      yield `/${segments.join('/')}`;
      serial += 1;
      if (serial % 7 === 0) {
        yield `${segments.join('/')}/`;
        yield `//${segments.join('//')}//`;
      }
      let place = length - 1;
      while (place >= 0) {
        const next = (indexes[place] ?? 0) + 1;
        if (next < (positions[place]?.length ?? 0)) {
          indexes[place] = next;
          break;
        }
        indexes[place] = 0;
        place -= 1;
      }
      if (place < 0) break;
    }
  }
  yield '';
  yield '/';
  yield '//';
}

describe('the compiled route matcher answers as the per-call one did', () => {
  for (const shape of SHAPES) {
    test(shape.name, () => {
      const contract = defineContract(
        { prefix: shape.prefix },
        {
          endpoint: {
            method: 'GET',
            path: shape.path,
            desc: shape.name,
            output: Out,
            ...(shape.path.includes(':')
              ? {
                  params: z.object({
                    id: z.string().optional(),
                    provider: z.string().optional(),
                    filePath: z.string().optional(),
                  }),
                }
              : {}),
          },
        },
      );
      const [matcher] = contractEndpointMatchers(
        contract,
        undefined,
        shape.keys && typeof shape.pathPrefix === 'function'
          ? {
              stripPrefixKeys: shape.keys,
              pathPrefix: (args: Record<string, string>) => {
                const make = shape.pathPrefix;
                return typeof make === 'function' ? make(args) : '';
              },
            }
          : shape.pathPrefix
            ? { pathPrefix: shape.pathPrefix as string }
            : undefined,
      );
      const { route: joined, markers } = route(shape);
      const oracle = legacyMatcher(joined, markers);

      let compared = 0;
      let accepted = 0;
      let refused = 0;
      const disagreements: string[] = [];
      for (const path of corpus(joined.split('/').filter(Boolean), markers)) {
        const expected = oracle(path);
        compared += 1;
        if (expected) accepted += 1;
        else refused += 1;
        if (matcher?.(path) !== expected && disagreements.length < 5) disagreements.push(path);
      }

      expect(disagreements).toEqual([]);
      // The enumeration reaches both answers; an equivalence over only refusals proves nothing.
      expect(accepted).toBeGreaterThan(0);
      expect(refused).toBeGreaterThan(0);
      expect(compared).toBeGreaterThan(100);
    });
  }

  test('a malformed escape and a slash inside a scope segment keep their old answers', () => {
    const contract = defineContract(
      { prefix: 'areas' },
      { search: { method: 'GET', path: '/search', desc: 'search', output: Out } },
    );
    const [matcher] = contractEndpointMatchers(contract, undefined, {
      stripPrefixKeys: ['tenantId'],
      pathPrefix: ({ tenantId }) => `tenants/${tenantId}`,
    });
    // A marker stands for "one or more characters that are not a slash", after decoding.
    expect(matcher?.('/tenants/t%20one/areas/search')).toBe(true);
    expect(matcher?.('/tenants/t%2Fone/areas/search')).toBe(false);
    expect(matcher?.('/tenants/%zz/areas/search')).toBe(true);
    expect(matcher?.('/tenants//areas/search')).toBe(false);
  });
});
