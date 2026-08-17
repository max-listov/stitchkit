import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineContract } from '../src/contract';
import { createScopedImplement, createScopedImplementRegistry } from '../src/server/implement';

const output = z.object({ ok: z.boolean() });

const posts = defineContract(
  { prefix: 'posts', scope: 'user' },
  {
    list: { method: 'GET', path: '/', desc: 'List posts', output },
    purge: { method: 'DELETE', path: '/all', desc: 'Purge posts', scope: 'admin', output },
  },
);

const health = defineContract(
  { prefix: 'health' },
  { read: { method: 'GET', path: '/', desc: 'Read health', output } },
);

const registry = { posts, health };

const implementAll = createScopedImplementRegistry<{
  public: object;
  user: { userId: string };
  admin: { userId: string; isAdmin: boolean };
}>();

describe('createScopedImplementRegistry', () => {
  test('binds every contract and keeps each endpoint effective scope', () => {
    const services = implementAll(registry, {
      posts: {
        list: (ctx) => ({ ok: ctx.userId.length > 0 }),
        purge: (ctx) => ({ ok: ctx.isAdmin }),
      },
      health: { read: () => ({ ok: true }) },
    });

    expect(services.map((service) => service.prefix)).toEqual(['posts', 'health']);
    expect(services[0]?.methods.list?.scope).toBe('user');
    expect(services[0]?.methods.purge?.scope).toBe('admin');
    expect(services[1]?.methods.read?.scope).toBe('public');
  });

  test('keeps the registry mismatch checks of implementRegistry', () => {
    expect(() => Reflect.apply(implementAll, undefined, [registry, { posts: {} }])).toThrow(
      '[stitchkit] implementRegistry: registry mismatch (missing: health; extra: none)',
    );
  });

  test('keeps the per-contract endpoint mismatch check', () => {
    expect(() =>
      Reflect.apply(implementAll, undefined, [
        registry,
        { posts: { list: () => ({ ok: true }) }, health: { read: () => ({ ok: true }) } },
      ]),
    ).toThrow(
      '[stitchkit] implementRegistry: handlers for "posts" mismatch (missing: purge; extra: none)',
    );
  });
});

describe('createScopedImplement().stream', () => {
  const media = defineContract(
    { prefix: 'media', scope: 'user' },
    {
      upload: {
        method: 'POST',
        path: '/',
        desc: 'Stream media',
        scope: 'admin',
        output: z.object({ stored: z.string(), by: z.string() }),
        multipart: {
          delivery: 'stream' as const,
          files: { file: { contentTypes: ['text/plain'] } },
        },
      },
    },
  );

  const implementFor = createScopedImplement<{
    public: object;
    user: { userId: string };
    admin: { userId: string; isAdmin: boolean };
  }>();

  test('builds a streaming implementation whose handler reads the scope context', async () => {
    const service = implementFor(media, {
      upload: implementFor.stream('admin', media.endpoints.upload, {
        files: {
          file: async ({ stream }) => ({
            value: await new Response(stream).text(),
            cleanup: () => undefined,
          }),
        },
        handler: ({ files, userId }) => ({ stored: files.file, by: userId }),
      }),
    });

    expect(service.methods.upload?.scope).toBe('admin');

    const result = await service.methods.upload?.handler({
      params: undefined,
      input: undefined,
      source: 'http',
      userId: 'u1',
      files: { file: 'payload' },
    });

    expect(result).toEqual({ stored: 'payload', by: 'u1' });
  });

  test('still rejects receivers that do not match the declared file fields', () => {
    expect(() =>
      Reflect.apply(implementFor.stream, undefined, [
        'admin',
        media.endpoints.upload,
        { files: {}, handler: () => ({ stored: '', by: '' }) },
      ]),
    ).toThrow('Streaming multipart receivers must exactly match declared file fields');
  });
});
