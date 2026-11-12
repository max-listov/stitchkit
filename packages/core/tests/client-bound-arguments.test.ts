import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  type ClientFetch,
  createClient,
  createClients,
  createScopedClients,
  createScopedUrlBuilders,
  createUrlBuilder,
  createUrlBuilders,
} from '../src/browser/client';
import { createHttpClient } from '../src/browser/http';
import { defineContract } from '../src/entrypoints/contract';

const Ok = z.object({ ok: z.boolean() });
const site = defineContract(
  { prefix: 'api/site', scope: 'site' },
  {
    session: { method: 'GET', path: '/:slug/session', desc: 'Session', output: Ok },
    course: {
      method: 'GET',
      path: '/:slug/courses/:courseSlug',
      desc: 'Course',
      input: z.object({ lang: z.string().optional() }),
      output: Ok,
    },
    order: {
      method: 'POST',
      path: '/:slug/orders',
      desc: 'Order',
      input: z.object({ item: z.string(), lang: z.string().optional() }),
      output: Ok,
    },
    rename: {
      method: 'POST',
      path: '/:slug/rename',
      desc: 'Rename',
      input: z.object({ title: z.string() }),
      output: Ok,
    },
    upload: {
      method: 'POST',
      path: '/:slug/upload',
      desc: 'Upload',
      multipart: { files: { file: {} } },
      input: z.object({ title: z.string() }),
      output: Ok,
    },
    pay: {
      method: 'POST',
      path: '/:slug/pay',
      desc: 'Pay',
      input: z.union([
        z.object({ kind: z.literal('card'), token: z.string() }),
        z.object({ kind: z.literal('invoice'), email: z.string() }),
      ]),
      output: Ok,
    },
    tags: {
      method: 'POST',
      path: '/:slug/tags',
      desc: 'Tags',
      input: z.record(z.string(), z.string()),
      output: Ok,
    },
    hidden: {
      method: 'GET',
      path: '/:slug/hidden',
      desc: 'Tool',
      expose: ['MCP'],
      output: Ok,
    },
  },
);

interface Sent {
  method: string;
  url: string;
  body: string;
}

/** A fetch that records what left the client, with multipart boundaries made comparable. */
function recorder(): { fetch: ClientFetch; sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    sent,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const boundary = /boundary=(.+)$/.exec(request.headers.get('content-type') ?? '')?.[1];
      const text = await request.text();
      sent.push({
        method: request.method,
        url: request.url,
        body: boundary ? text.replaceAll(boundary, 'BOUNDARY') : text,
      });
      return Response.json({ ok: true });
    },
  };
}

const baseUrl = 'http://site.test';
const file = () => new Blob(['bytes'], { type: 'text/plain' });

/** One call of every shape through an explicit client and through a bound one. */
async function sameRequests(
  build: (fetch: ClientFetch) => {
    explicit: ReturnType<typeof createClient<typeof site.endpoints>>;
    bound: ReturnType<
      typeof createClient<typeof site.endpoints, never, { slug: string; lang: string }>
    >;
  },
): Promise<void> {
  const explicitWire = recorder();
  const boundWire = recorder();
  const { explicit } = build(explicitWire.fetch);
  const { bound } = build(boundWire.fetch);

  await explicit.session({ slug: 'acme' });
  await bound.session();
  await explicit.course({ slug: 'acme', courseSlug: 'intro', lang: 'th' });
  await bound.course({ courseSlug: 'intro' });
  await explicit.order({ slug: 'acme', item: 'book', lang: 'th' });
  await bound.order({ item: 'book' });
  // `rename` declares no `lang`: the bound value is not added to its body.
  await explicit.rename({ slug: 'acme', title: 'New' });
  await bound.rename({ title: 'New' });
  await explicit.upload({ slug: 'acme', title: 'Doc', file: file() });
  await bound.upload({ title: 'Doc', file: file() });
  await explicit.pay({ slug: 'acme', kind: 'card', token: 't' });
  await bound.pay({ kind: 'card', token: 't' });
  await explicit.session.withOptions({ slug: 'acme' }, {});
  await bound.session.withOptions({});
  await explicit.order.withOptions({ slug: 'acme', item: 'pen', lang: 'th' }, {});
  await bound.order.withOptions({ item: 'pen' }, {});

  expect(boundWire.sent).toEqual(explicitWire.sent);
  expect(explicitWire.sent.map((request) => `${request.method} ${request.url}`)).toEqual([
    'GET http://site.test/api/site/acme/session',
    'GET http://site.test/api/site/acme/courses/intro?lang=th',
    'POST http://site.test/api/site/acme/orders',
    'POST http://site.test/api/site/acme/rename',
    'POST http://site.test/api/site/acme/upload',
    'POST http://site.test/api/site/acme/pay',
    'GET http://site.test/api/site/acme/session',
    'POST http://site.test/api/site/acme/orders',
  ]);
  expect(JSON.parse(explicitWire.sent[2]?.body ?? '')).toEqual({ item: 'book', lang: 'th' });
  expect(JSON.parse(boundWire.sent[3]?.body ?? '')).toEqual({ title: 'New' });
  expect(boundWire.sent[4]?.body).toContain('name="title"');
  expect(boundWire.sent[4]?.body).not.toContain('name="lang"');
}

describe('a client with bound arguments', () => {
  const bound = { slug: 'acme', lang: 'th' };

  test('sends the request an explicit call sends, over the bare fetch client', async () => {
    await sameRequests((fetch) => ({
      explicit: createClient(site, { baseUrl, fetch }),
      bound: createClient(site, { baseUrl, fetch }, { bound }),
    }));
  });

  test('sends the request an explicit call sends, over a configured HTTP client', async () => {
    await sameRequests((fetch) => ({
      explicit: createClient(site, createHttpClient({ baseUrl, fetch })),
      bound: createClient(site, createHttpClient({ baseUrl, fetch }), { bound }),
    }));
  });

  test('a bound value wins over the same key passed by an untyped caller', async () => {
    const wire = recorder();
    const api = createClient(
      site,
      { baseUrl, fetch: wire.fetch },
      { bound: { slug: 'acme' } },
    );
    await Reflect.apply(api.course, undefined, [{ slug: 'other', courseSlug: 'intro' }]);
    expect(wire.sent[0]?.url).toBe('http://site.test/api/site/acme/courses/intro');
  });

  test('an input that can take undeclared fields keeps its argument and gains no bound key', async () => {
    const wire = recorder();
    const api = createClient(site, { baseUrl, fetch: wire.fetch }, { bound });
    await api.tags({ colour: 'red' });
    expect(wire.sent[0]?.url).toBe('http://site.test/api/site/acme/tags');
    expect(JSON.parse(wire.sent[0]?.body ?? '')).toEqual({ colour: 'red' });
  });

  test('with nothing bound for it, an endpoint keeps its own call shape', async () => {
    // Callers that forward by the endpoint's declaration (a remote tool mount) pass
    // `withOptions(args, options)` to every endpoint that declares an input, an empty one included.
    const empty = defineContract(
      { prefix: 'empty' },
      {
        ping: { method: 'POST', path: '/ping', desc: 'Ping', input: z.object({}), output: Ok },
      },
    );
    const wire = recorder();
    const api = createClient(
      empty,
      { baseUrl, fetch: wire.fetch },
      { bound: { slug: 'acme' } },
    );
    await Reflect.apply(api.ping.withOptions, undefined, [{}, {}]);
    expect(wire.sent).toEqual([
      { method: 'POST', url: 'http://site.test/empty/ping', body: '' },
    ]);
  });

  test('binds a key the path prefix consumes', async () => {
    const wire = recorder();
    const api = createClient(
      site,
      { baseUrl, fetch: wire.fetch },
      {
        pathPrefix: ({ tenantId }) => `tenants/${tenantId}`,
        stripPrefixKeys: ['tenantId'],
        bound: { tenantId: 't1', slug: 'acme' },
      },
    );
    await api.session();
    await api.order({ item: 'book' });
    expect(wire.sent.map((request) => request.url)).toEqual([
      'http://site.test/tenants/t1/api/site/acme/session',
      'http://site.test/tenants/t1/api/site/acme/orders',
    ]);
    expect(JSON.parse(wire.sent[1]?.body ?? '')).toEqual({ item: 'book' });
  });

  test('batch and scoped registries bind the same way', async () => {
    const wire = recorder();
    const batch = createClients({ site }, { baseUrl, fetch: wire.fetch }, { bound });
    const scoped = createScopedClients(
      { site },
      { baseUrl, fetch: wire.fetch },
      { site: { bound: { slug: 'acme' } } },
    );
    await batch.site.session();
    await batch.site.order({ item: 'book' });
    await scoped.site.session();
    await scoped.site.course({ courseSlug: 'intro', lang: 'en' });
    expect(wire.sent.map((request) => request.url)).toEqual([
      'http://site.test/api/site/acme/session',
      'http://site.test/api/site/acme/orders',
      'http://site.test/api/site/acme/session',
      'http://site.test/api/site/acme/courses/intro?lang=en',
    ]);
    expect(JSON.parse(wire.sent[1]?.body ?? '')).toEqual({ item: 'book', lang: 'th' });
  });

  test('URL builders bind the same way', () => {
    const explicit = createUrlBuilder(site, { baseUrl });
    const one = createUrlBuilder(site, { baseUrl }, { bound });
    const batch = createUrlBuilders({ site }, { baseUrl }, { bound: { slug: 'acme' } });
    const scoped = createScopedUrlBuilders(
      { site },
      { baseUrl },
      { site: { bound: { slug: 'acme' } } },
    );
    expect(one.session()).toBe(explicit.session({ slug: 'acme' }));
    expect(one.course({ courseSlug: 'intro' })).toBe(
      explicit.course({ slug: 'acme', courseSlug: 'intro', lang: 'th' }),
    );
    // A body verb's URL takes path parameters only: a bound body field is not a "non-URL field".
    expect(one.order()).toBe('http://site.test/api/site/acme/orders');
    expect(batch.site.session()).toBe('http://site.test/api/site/acme/session');
    expect(scoped.site.course({ courseSlug: 'intro' })).toBe(
      'http://site.test/api/site/acme/courses/intro',
    );
  });
});

// Never executed — the `check` step (`tsc --noEmit`) validates these.
function _typeChecks() {
  const config = { baseUrl };
  const api = createClient(site, config, { bound: { slug: 'acme' } });

  // An operation whose only argument is bound is called with none.
  void api.session();
  void api.session.withOptions({ signal: new AbortController().signal });
  // @ts-expect-error the bound key is not an argument any more
  void api.session({ slug: 'acme' });
  // @ts-expect-error the bound key is not an argument any more
  void api.course({ slug: 'acme', courseSlug: 'intro' });
  // @ts-expect-error the remaining required argument is still required
  void api.course({});
  // @ts-expect-error the remaining required argument is still required
  void api.course();
  void api.course({ courseSlug: 'intro', lang: 'th' });
  void api.order({ item: 'book' });
  // @ts-expect-error a remaining argument keeps its type
  void api.order({ item: 1 });
  void api.upload({ title: 'Doc', file: new Blob([]) });
  // A union input keeps its variants once the bound key is gone.
  void api.pay({ kind: 'card', token: 't' });
  void api.pay({ kind: 'invoice', email: 'a@b.c' });
  // @ts-expect-error a variant keeps its own required field
  void api.pay({ kind: 'invoice', token: 't' });
  // @ts-expect-error tool-only endpoints are absent from HTTP clients
  void api.hidden;

  // A bound optional field leaves the args too.
  const both = createClient(site, config, { bound: { slug: 'acme', lang: 'th' } });
  void both.order({ item: 'book' });
  // @ts-expect-error the bound key is not an argument any more
  void both.order({ item: 'book', lang: 'en' });

  // An unbound client keeps the contract's args.
  const plain = createClient(site, config);
  void plain.session({ slug: 'acme' });
  // @ts-expect-error nothing is bound
  void plain.session();

  // A key the path prefix consumes is bound like any other.
  const tenant = createClient(site, config, {
    pathPrefix: ({ tenantId }) => `tenants/${tenantId}`,
    stripPrefixKeys: ['tenantId'],
    bound: { tenantId: 't1' },
  });
  void tenant.session({ slug: 'acme' });
  // @ts-expect-error the prefix key is bound
  void tenant.session({ slug: 'acme', tenantId: 't1' });

  const batch = createClients({ site }, config, { bound: { slug: 'acme' } });
  void batch.site.session();
  // @ts-expect-error the bound key is not an argument any more
  void batch.site.session({ slug: 'acme' });

  const scoped = createScopedClients({ site }, config, { site: { bound: { slug: 'acme' } } });
  void scoped.site.session();
  void scoped.site.course({ courseSlug: 'intro' });
  // @ts-expect-error the bound key is not an argument any more
  void scoped.site.session({ slug: 'acme' });

  const urls = createUrlBuilder(site, config, { bound: { slug: 'acme' } });
  const sessionUrl: string = urls.session();
  void sessionUrl;
  void urls.course({ courseSlug: 'intro' });
  // @ts-expect-error the bound key is not an argument any more
  void urls.session({ slug: 'acme' });
  const scopedUrls = createScopedUrlBuilders({ site }, config, {
    site: { bound: { slug: 'acme' } },
  });
  void scopedUrls.site.session();
  void createUrlBuilders({ site }, config, { bound: { slug: 'acme' } }).site.session();
}
void _typeChecks;
