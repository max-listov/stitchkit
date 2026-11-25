/**
 * A signed, short-lived link to a raw-response endpoint, checked by the server's own auth gate.
 *
 * `<audio src>` and `<img src>` send no `Authorization` header, so an endpoint serving private
 * bytes cannot be reached with the session the page holds. The server hands out a link that
 * carries its own proof instead: an expiry and an HMAC over the method, the path and every query
 * parameter. The endpoint stays in the contract; `createAuthHook`'s `resolve` accepts the link,
 * so the handler has no guard of its own.
 */
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineContract } from '../src/entrypoints/contract';
import {
  createAuthHook,
  createHandler,
  implement,
  type RawRoute,
  signLink,
  verifySignedLink,
} from '../src/entrypoints/server';

const SECRET = 'a-media-link-secret-of-at-least-32-chars';
const OTHER_SECRET = 'another-secret-also-at-least-32-characters';
const issuedAt = new Date('2026-11-24T12:00:00.000Z');
let clock = issuedAt;
const now = () => clock;

const MediaParams = z.object({ id: z.string() });
const media = defineContract(
  { prefix: 'media', scope: 'viewer' },
  {
    audio: {
      method: 'GET',
      path: '/:id',
      desc: 'Stream a private recording',
      params: MediaParams,
      rawResponse: true,
      contentType: 'audio/mpeg',
    },
    inspect: {
      method: 'HEAD',
      path: '/:id',
      desc: 'Inspect a private recording',
      params: MediaParams,
      rawResponse: true,
      contentType: 'audio/mpeg',
    },
  },
);

const served: string[] = [];
const auth = createAuthHook<{ viewer: string }>({
  // A session would be tried here too; this test has only links.
  resolve: async (ctx) => {
    if (!ctx.req) return null;
    const link = await verifySignedLink(ctx.req, { secret: SECRET, now });
    if (!link.ok) return null;
    return { viewer: new URL(ctx.req.url).searchParams.get('for') ?? '' };
  },
  rules: { viewer: 'authenticated' },
});
const handler = createHandler({
  services: [
    implement(media, {
      audio: ({ params }) => {
        served.push(params.id);
        return new Response(`bytes of ${params.id}`, {
          headers: { 'content-type': 'audio/mpeg' },
        });
      },
      inspect: () => new Response(null),
    }),
  ],
  hooks: { authorize: auth },
});

const get = (link: string, method = 'GET') =>
  handler(new Request(new URL(link, 'http://local'), { method }));

describe('a signed link through the auth gate', () => {
  test('the link the server signed opens the endpoint, with no session', async () => {
    clock = issuedAt;
    const link = await signLink({
      secret: SECRET,
      method: 'GET',
      url: '/media/r1?for=u1',
      expiresInSeconds: 300,
      now,
    });
    expect(link).toMatch(/^\/media\/r1\?for=u1&expires=\d+&signature=[A-Za-z0-9_-]{43}$/);
    const response = await get(link);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('bytes of r1');
    expect(served).toEqual(['r1']);
  });

  test('control: no link, another path, an edited parameter, another method or secret are refused', async () => {
    clock = issuedAt;
    served.length = 0;
    const link = await signLink({
      secret: SECRET,
      method: 'GET',
      url: '/media/r1?for=u1',
      expiresInSeconds: 300,
      now,
    });
    const foreign = await signLink({
      secret: OTHER_SECRET,
      method: 'GET',
      url: '/media/r1?for=u1',
      expiresInSeconds: 300,
      now,
    });
    for (const refused of [
      '/media/r1?for=u1',
      link.replace('/media/r1', '/media/r2'),
      link.replace('for=u1', 'for=u2'),
      `${link}&extra=1`,
      foreign,
    ])
      expect((await get(refused)).status).toBe(401);
    expect((await get(link, 'HEAD')).status).toBe(401);
    expect(served).toEqual([]);
    expect((await get(link)).status).toBe(200);
  });

  test('a link stops opening the endpoint once it expires', async () => {
    clock = issuedAt;
    const link = await signLink({
      secret: SECRET,
      method: 'GET',
      url: '/media/r1',
      expiresInSeconds: 60,
      now,
    });
    clock = new Date(issuedAt.getTime() + 60_000);
    expect((await get(link)).status).toBe(200);
    clock = new Date(issuedAt.getTime() + 61_000);
    expect((await get(link)).status).toBe(401);
  });
});

describe('verifySignedLink', () => {
  const verify = (link: string, method = 'GET', secret = SECRET) =>
    verifySignedLink(new Request(new URL(link, 'http://local'), { method }), { secret, now });

  test('names why a link is refused', async () => {
    clock = issuedAt;
    const link = await signLink({
      secret: SECRET,
      method: 'GET',
      url: '/media/r1',
      expiresInSeconds: 60,
      now,
    });
    expect(await verify(link)).toEqual({
      ok: true,
      expiresAt: new Date(issuedAt.getTime() + 60_000),
    });
    expect(await verify('/media/r1')).toEqual({ ok: false, reason: 'unsigned' });
    expect(await verify('/media/r1?expires=soon&signature=x')).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(await verify(link, 'GET', OTHER_SECRET)).toEqual({ ok: false, reason: 'forged' });
    expect(await verify(link, 'HEAD')).toEqual({ ok: false, reason: 'forged' });
    clock = new Date(issuedAt.getTime() + 61_000);
    expect(await verify(link)).toEqual({ ok: false, reason: 'expired' });
  });

  test('an absolute URL stays absolute, and the host is not part of what is signed', async () => {
    clock = issuedAt;
    const link = await signLink({
      secret: SECRET,
      method: 'GET',
      url: 'https://media.example.com/media/r1?for=u1',
      expiresInSeconds: 60,
      now,
    });
    expect(link.startsWith('https://media.example.com/media/r1?for=u1&expires=')).toBe(true);
    // Behind a proxy the server sees another origin; the path and query are what it checks.
    const seen = link.replace('https://media.example.com', 'http://127.0.0.1:3000');
    expect(await verify(seen)).toMatchObject({ ok: true });
  });

  test('a raw route checks the same link with the same call', async () => {
    clock = issuedAt;
    const route: RawRoute = {
      method: 'GET',
      path: '/files/:name',
      handler: async (req) => {
        const link = await verifySignedLink(req, { secret: SECRET, now });
        return link.ok ? new Response('file') : new Response(null, { status: 401 });
      },
    };
    const raw = createHandler({ services: [], rawRoutes: [route] });
    const link = await signLink({
      secret: SECRET,
      method: 'GET',
      url: '/files/a.png',
      expiresInSeconds: 60,
      now,
    });
    expect((await raw(new Request(new URL(link, 'http://local')))).status).toBe(200);
    expect((await raw(new Request('http://local/files/a.png'))).status).toBe(401);
  });

  test('a weak secret, an unbounded lifetime or a link that already carries the reserved names are refused', async () => {
    const base = {
      secret: SECRET,
      method: 'GET',
      url: '/media/r1',
      expiresInSeconds: 60,
      now,
    };
    await expect(signLink({ ...base, secret: 'short' })).rejects.toThrow(TypeError);
    await expect(signLink({ ...base, expiresInSeconds: 0 })).rejects.toThrow(TypeError);
    await expect(signLink({ ...base, expiresInSeconds: 1.5 })).rejects.toThrow(TypeError);
    await expect(signLink({ ...base, expiresInSeconds: 7 * 24 * 3600 + 1 })).rejects.toThrow(
      TypeError,
    );
    await expect(signLink({ ...base, url: '/media/r1?signature=x' })).rejects.toThrow(
      TypeError,
    );
    await expect(signLink({ ...base, url: '/media/r1?expires=1' })).rejects.toThrow(TypeError);
    await expect(signLink({ ...base, method: 'get' })).rejects.toThrow(TypeError);
    await expect(
      verifySignedLink(new Request('http://local/media/r1'), { secret: 'short' }),
    ).rejects.toThrow(TypeError);
  });
});
