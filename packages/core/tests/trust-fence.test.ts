/**
 * The trust fence — and the discipline its tests are written under.
 *
 * A 403 proves nothing on its own: CORS, admission during shutdown, a missing
 * route and the fence can all produce one, and they are indistinguishable by
 * status. So every refusal here is asserted by its **side effect** — the handler
 * was not called — which is false for every other source of a 403 and would stay
 * false if the fence were deleted entirely.
 */
import { describe, expect, test } from 'bun:test';
import { defineContract } from '../src/contract';
import { createHandler } from '../src/server/create';
import { implement } from '../src/server/implement';
import { composeLifecycleHooks } from '../src/server/lifecycle';
import { createTrustFence, isLoopbackAddress } from '../src/server/middleware/trust-fence';

const contract = defineContract(
  { prefix: 'notes' },
  { list: { method: 'GET', path: '/', desc: 'List notes' } },
);

/** A handler that counts how many times the operation actually ran. */
function fencedHandler(trustedHosts: readonly string[]) {
  let handled = 0;
  const fence = createTrustFence({ trustedHosts });
  const handler = createHandler({
    services: [
      implement(contract, {
        list: () => {
          handled += 1;
        },
      }),
    ],
    hooks: fence.hooks,
  });
  return { fence, handler, handled: () => handled };
}

function request(headers: Record<string, string>): Request {
  // The URL deliberately says `localhost` while `Host` may say something else:
  // that is the shape the Node Socket.IO lane synthesises, and a fence reading
  // `new URL(request.url).host` would read this as trusted every time.
  return new Request('http://localhost/notes', { headers });
}

describe('a list entry has to be an authority', () => {
  test.each([
    ['a path', 'harness.internal/path'],
    ['a scheme', 'http://harness.internal'],
    ['credentials', 'user@harness.internal'],
    ['a wildcard', '*.harness.internal:5180'],
    ['an impossible port', 'harness.internal:70000'],
    ['nothing at all', ''],
  ])('%s in an entry stops startup, naming the entry', (_case, entry) => {
    expect(() => createTrustFence({ trustedHosts: [entry] })).toThrow(
      new RegExp(`"${entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" is not an authority`),
    );
  });

  test('an empty list is refused rather than silently refusing every request', () => {
    expect(() => createTrustFence({ trustedHosts: [] })).toThrow(/cannot be empty/);
  });

  test('an entry naming a default port stays bound to that port', () => {
    // `new URL('http://example.com:80').host` drops the port, so an entry parsed
    // through the URL alone would widen from "port 80" to "any port" — a fence
    // entry meaning strictly more than it says.
    const fence = createTrustFence({ trustedHosts: ['harness.internal:80'] });
    expect(fence.check(request({ host: 'harness.internal:80' }), 'http')).toBeUndefined();
    expect(fence.check(request({ host: 'harness.internal:9999' }), 'http')?.reason).toBe(
      'untrusted-host',
    );
  });
});

describe('the http lane refuses before the operation runs', () => {
  test('a trusted authority reaches the handler', async () => {
    const { handler, handled } = fencedHandler(['harness.internal:5180']);
    const response = await handler(request({ host: 'harness.internal:5180' }));
    expect(response.status).toBe(204);
    expect(handled()).toBe(1);
  });

  test('an untrusted authority is refused and the handler never runs', async () => {
    const { handler, handled } = fencedHandler(['harness.internal:5180']);
    const response = await handler(request({ host: 'evil.example:5180' }));
    expect(response.status).toBe(403);
    // The assertion that means something: a 403 from anywhere else would still
    // have dispatched, or would not be a fence at all.
    expect(handled()).toBe(0);
  });

  test('an absent Host is refused, even though the URL says localhost', async () => {
    const { fence, handler, handled } = fencedHandler(['localhost']);
    // `new Request` adds no Host header of its own; this is the HTTP/1.0-shaped
    // request whose synthesised URL would otherwise read as the loopback name.
    const response = await handler(new Request('http://localhost/notes'));
    expect(fence.check(new Request('http://localhost/notes'), 'http')?.reason).toBe(
      'missing-host',
    );
    expect(response.status).toBe(403);
    expect(handled()).toBe(0);
  });

  test('an entry without a port trusts that host on any port', () => {
    const fence = createTrustFence({ trustedHosts: ['harness.internal'] });
    expect(fence.check(request({ host: 'harness.internal:5180' }), 'http')).toBeUndefined();
    expect(fence.check(request({ host: 'harness.internal:9999' }), 'http')).toBeUndefined();
    expect(fence.check(request({ host: 'other.internal' }), 'http')?.reason).toBe(
      'untrusted-host',
    );
  });

  test('the comparison is normalised, not textual', () => {
    const fence = createTrustFence({ trustedHosts: ['HARNESS.internal'] });
    expect(fence.check(request({ host: 'harness.internal' }), 'http')).toBeUndefined();
    // Not a prefix, not a suffix, not a pattern: an exact authority.
    expect(
      fence.check(request({ host: 'harness.internal.evil.example' }), 'http')?.reason,
    ).toBe('untrusted-host');
    expect(fence.check(request({ host: 'notharness.internal' }), 'http')?.reason).toBe(
      'untrusted-host',
    );
  });
});

describe('what the browser says about the request', () => {
  test('an Origin that disagrees with the Host is refused before the handler', async () => {
    const { handler, handled } = fencedHandler(['harness.internal:5180']);
    const response = await handler(
      request({ host: 'harness.internal:5180', origin: 'http://evil.example:5180' }),
    );
    expect(response.status).toBe(403);
    expect(handled()).toBe(0);
  });

  test('an Origin that agrees is not in the way', async () => {
    const { handler, handled } = fencedHandler(['harness.internal:5180']);
    const response = await handler(
      request({ host: 'harness.internal:5180', origin: 'http://harness.internal:5180' }),
    );
    expect(response.status).toBe(204);
    expect(handled()).toBe(1);
  });

  test('a default port on one side only still agrees', () => {
    const fence = createTrustFence({ trustedHosts: ['harness.internal'] });
    expect(
      fence.check(
        request({ host: 'harness.internal', origin: 'https://harness.internal:443' }),
        'http',
      ),
    ).toBeUndefined();
  });

  test('sec-fetch-site: cross-site is refused', () => {
    const fence = createTrustFence({ trustedHosts: ['harness.internal'] });
    expect(
      fence.check(
        request({ host: 'harness.internal', 'sec-fetch-site': 'cross-site' }),
        'http',
      )?.reason,
    ).toBe('cross-site');
    expect(
      fence.check(
        request({ host: 'harness.internal', 'sec-fetch-site': 'same-origin' }),
        'http',
      ),
    ).toBeUndefined();
  });

  test('an opaque Origin states no authority, so it is neither a match nor a mismatch', () => {
    const fence = createTrustFence({ trustedHosts: ['harness.internal'] });
    expect(
      fence.check(request({ host: 'harness.internal', origin: 'null' }), 'http'),
    ).toBeUndefined();
  });
});

describe('a second origin of the same application', () => {
  // Reported by a consuming project running a UI dev server on one port against
  // an API on the next: both lanes refused, and there was nowhere to say the
  // second origin was expected. Their reproduction, with the host renamed off
  // `localhost` — a test may not carry a literal `localhost:NNNN`, and the shape
  // under test is a port that differs, not which host it is.
  const declared = () =>
    createTrustFence({
      trustedHosts: ['app.internal:5181'],
      trustedOrigins: ['app.internal:5180'],
    });

  function apiRequest(origin?: string): Request {
    return new Request('http://app.internal:5181/x', {
      headers: { host: 'app.internal:5181', ...(origin !== undefined && { origin }) },
    });
  }

  test('a declared origin is accepted on both lanes', async () => {
    const fence = declared();
    expect(fence.check(apiRequest('http://app.internal:5180'), 'http')).toBeUndefined();
    expect(await fence.allowRequest(apiRequest('http://app.internal:5180'))).toBe(true);
  });

  test('an undeclared origin is still refused — the default did not widen', () => {
    // The negative control, and the more important half: adding a way to declare
    // one must not turn the check off for everyone who declares none.
    const fence = createTrustFence({ trustedHosts: ['app.internal:5181'] });
    expect(fence.check(apiRequest('http://app.internal:5180'), 'http')?.reason).toBe(
      'origin-mismatch',
    );
  });

  test('declaring one origin does not admit another host', () => {
    expect(declared().check(apiRequest('http://evil.example:5180'), 'http')?.reason).toBe(
      'origin-mismatch',
    );
  });

  test('an origin entry without a port trusts that host on any port', () => {
    const fence = createTrustFence({
      trustedHosts: ['app.internal:5181'],
      trustedOrigins: ['app.internal'],
    });
    expect(fence.check(apiRequest('http://app.internal:5180'), 'http')).toBeUndefined();
    expect(fence.check(apiRequest('http://app.internal:9999'), 'http')).toBeUndefined();
  });

  test('a trustedOrigins entry that is not an authority stops startup, naming it', () => {
    expect(() =>
      createTrustFence({
        trustedHosts: ['app.internal:5181'],
        trustedOrigins: ['http://app.internal:5180'],
      }),
    ).toThrow(/trustedOrigins entry "http:\/\/app.internal:5180" is not an authority/);
  });

  test('the Host list is still what refuses an untrusted authority', () => {
    // Stated as a test because the reasoning behind the fix is that the Origin
    // check never was the rebinding defence — trustedHosts is. If declaring an
    // origin loosened that, the fix would have traded the real guard for the
    // wrong one.
    const fence = declared();
    const rebind = new Request('http://app.internal:5181/x', {
      headers: { host: 'evil.example:5181', origin: 'http://evil.example:5181' },
    });
    expect(fence.check(rebind, 'http')?.reason).toBe('untrusted-host');
  });
});

describe('the socket lane', () => {
  test('allowRequest answers for the lane that never reaches onRequest', async () => {
    const fence = createTrustFence({ trustedHosts: ['harness.internal:5180'] });
    expect(await fence.allowRequest(request({ host: 'harness.internal:5180' }))).toBe(true);
    expect(await fence.allowRequest(request({ host: 'evil.example:5180' }))).toBe(false);
    expect(await fence.allowRequest(new Request('http://localhost/socket.io/'))).toBe(false);
  });

  test('a refusal names which lane it came from', () => {
    const seen: string[] = [];
    const fence = createTrustFence({
      trustedHosts: ['harness.internal'],
      onRefused: (refusal) => seen.push(`${refusal.lane}:${refusal.reason}`),
    });
    fence.check(request({ host: 'evil.example' }), 'http');
    fence.check(request({ host: 'evil.example' }), 'socket');
    expect(seen).toEqual(['http:untrusted-host', 'socket:untrusted-host']);
  });
});

describe('the two traps a reader walks into', () => {
  test('a fence composed after a hook that answers never runs', async () => {
    // Not a defect — `composeLifecycleHooks` stops at the first response by
    // design. It is pinned because the fence is the one hook where "did not run"
    // is silent and expensive, and the guide's ordering rule is only a sentence
    // until something fails when it is ignored.
    const fence = createTrustFence({ trustedHosts: ['harness.internal'] });
    const maintenance = {
      onRequest: () => new Response('maintenance', { status: 503 }),
    };

    const fenceFirst = composeLifecycleHooks(fence.hooks, maintenance);
    expect((await fenceFirst.onRequest?.(request({ host: 'evil.example' })))?.status).toBe(
      403,
    );

    const fenceLast = composeLifecycleHooks(maintenance, fence.hooks);
    expect((await fenceLast.onRequest?.(request({ host: 'evil.example' })))?.status).toBe(503);
  });

  test('a route group cannot declare onRequest, because it would never be dispatched', () => {
    // The type refuses it; this is the answer a JavaScript consumer gets. Before
    // this, `RouteGroup.hooks.onRequest` typechecked, ran, and fenced nothing —
    // the exact failure a per-group fence would have walked into first.
    expect(() =>
      createHandler({
        groups: [
          {
            pathPrefix: '/admin',
            services: [implement(contract, { list: () => undefined })],
            // @ts-expect-error — the point of the test: the type refuses it too
            hooks: { onRequest: () => undefined },
          },
        ],
      }),
    ).toThrow(/route group cannot declare `onRequest`/);
  });
});

describe('the operator hears about a refusal', () => {
  test('a supplied logger is warned, with the reason and the lane', () => {
    const warnings: { message: string; fields: unknown }[] = [];
    const fence = createTrustFence({
      trustedHosts: ['harness.internal'],
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: (message: string, fields?: unknown) => void warnings.push({ message, fields }),
        error: () => undefined,
      },
    });
    fence.check(request({ host: 'evil.example' }), 'socket');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.fields).toMatchObject({ reason: 'untrusted-host', lane: 'socket' });
  });
});

describe('isLoopbackAddress — for the auth rule, not for the fence', () => {
  test.each([
    ['127.0.0.1', true],
    ['127.9.9.9', true],
    ['::1', true],
    ['[::1]', true],
    ['::ffff:127.0.0.1', true],
    ['192.168.1.4', false],
    ['10.0.0.1', false],
    ['', false],
  ])('%s → %s', (address, expected) => {
    expect(isLoopbackAddress(address)).toBe(expected);
  });

  test('an address the runtime could not resolve is not a local one', () => {
    // `extractIp` returns '' when nothing is known. "Not known" answered as
    // "local" would hand a privileged operation to whoever the runtime failed to
    // identify — the third outcome collapsed into the most permissive one.
    expect(isLoopbackAddress('')).toBe(false);
  });
});
