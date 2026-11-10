/**
 * OpenAPI security metadata — the document names how a caller presents its
 * credential (`components.securitySchemes` + per-operation `security`), keyed
 * by the scopes the contracts already declare, and the runtime gate stays the
 * auth hook. A version-pinned external validator reads every document here, so
 * "valid OpenAPI" is the validator's verdict, not this file's opinion.
 */
import { describe, expect, test } from 'bun:test';
import { Validator } from '@seriousme/openapi-schema-validator';
import { z } from 'zod';
import { defineContract } from '../src/entrypoints/contract';
import {
  createAuthHook,
  createHandler,
  implement,
  type OpenApiSecurity,
  type OpenApiSecurityScheme,
} from '../src/entrypoints/server';
import { generateOpenApiDocument } from '../src/server/openapi';

const API_KEY = 'gv_test_key';

// The shape of a public API for headless clients: protected reads under an
// account scope, one open health check, one internal method the curated spec
// hides.
const transcriptions = defineContract(
  { prefix: 'transcriptions', scope: 'account' },
  {
    get: {
      method: 'GET',
      path: '/:id',
      desc: 'Read a transcription',
      params: z.strictObject({ id: z.string() }),
      output: z.object({ id: z.string() }),
      meta: { public: true },
    },
    health: {
      method: 'GET',
      path: '/health',
      desc: 'Report liveness',
      scope: 'public',
      output: z.object({ ok: z.boolean() }),
      meta: { public: true },
    },
    reindex: {
      method: 'POST',
      path: '/reindex',
      desc: 'Internal maintenance',
      scope: 'staff',
      output: z.object({ ok: z.boolean() }),
    },
  },
);

const service = implement(transcriptions, {
  get: (ctx) => ({ id: ctx.params.id }),
  health: () => ({ ok: true }),
  reindex: () => ({ ok: true }),
});

const bearer: OpenApiSecurityScheme = {
  type: 'http',
  scheme: 'bearer',
  description: 'An account API key',
};

function publicDocument(security: OpenApiSecurity | undefined) {
  return generateOpenApiDocument({
    info: { title: 'Transcription API', version: '1' },
    groups: [{ pathPrefix: 'api', services: [service] }],
    includeMethod: (method) => method.meta?.public === true,
    security,
  });
}

/** Read the document the way an external client does — plain JSON. */
function json(document: unknown) {
  return JSON.parse(JSON.stringify(document));
}

async function validate(document: unknown): Promise<{ valid: boolean; errors?: unknown }> {
  return new Validator().validate(json(document));
}

describe('generateOpenApiDocument — security', () => {
  test('a protected operation names its scheme, an open one names none, and the document validates', async () => {
    const document = json(
      publicDocument({ schemes: { apiKey: bearer }, scopes: { account: ['apiKey'] } }),
    );
    expect(document.components.securitySchemes).toEqual({ apiKey: bearer });
    expect(document.paths['/api/transcriptions/{id}'].get.security).toEqual([{ apiKey: [] }]);
    expect(document.paths['/api/transcriptions/health'].get.security).toBeUndefined();
    expect(document.paths['/api/transcriptions/health'].get.responses['401']).toBeUndefined();
    expect(await validate(document)).toEqual({ valid: true });
  });

  test('bearer, an API key header, a query key and a cookie each pass the external validator', async () => {
    const schemes: Record<string, OpenApiSecurityScheme> = {
      bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'opaque' },
      basic: { type: 'http', scheme: 'basic' },
      header: { type: 'apiKey', in: 'header', name: 'X-Api-Key' },
      query: { type: 'apiKey', in: 'query', name: 'api_key' },
      session: { type: 'apiKey', in: 'cookie', name: 'session' },
    };
    const document = json(
      publicDocument({
        schemes,
        scopes: { account: ['bearer', 'basic', 'header', 'query', 'session'] },
      }),
    );
    expect(document.paths['/api/transcriptions/{id}'].get.security).toEqual([
      { bearer: [] },
      { basic: [] },
      { header: [] },
      { query: [] },
      { session: [] },
    ]);
    expect(await validate(document)).toEqual({ valid: true });
  });

  test('the validator is a real control: a scheme OpenAPI does not allow fails it', async () => {
    const document = json(
      publicDocument({ schemes: { apiKey: bearer }, scopes: { account: ['apiKey'] } }),
    );
    document.components.securitySchemes.apiKey = { type: 'apiKey', in: 'body', name: 'key' };
    expect((await validate(document)).valid).toBe(false);
  });

  test('a protected scope with no scheme refuses generation and names the operation', () => {
    expect(() => publicDocument({ schemes: { apiKey: bearer }, scopes: {} })).toThrow(
      '[stitchkit] openapi: GET /api/transcriptions/{id} has scope "account", but security.scopes names no scheme for it',
    );
  });

  test('a hidden operation does not have to be described', () => {
    // `reindex` (scope `staff`) is filtered out by `includeMethod`, so the
    // mapping only answers for what the document advertises.
    expect(() =>
      publicDocument({ schemes: { apiKey: bearer }, scopes: { account: ['apiKey'] } }),
    ).not.toThrow();
  });

  test('a scope whose rule is public is declared by an empty list and stays open', () => {
    const anonymous = implement(
      defineContract(
        { prefix: 'status', scope: 'anyone' },
        {
          read: {
            method: 'GET',
            path: '/',
            desc: 'Read status',
            output: z.object({ up: z.boolean() }),
          },
        },
      ),
      { read: () => ({ up: true }) },
    );
    const document = json(
      generateOpenApiDocument({
        info: { title: 'Status', version: '1' },
        services: [anonymous],
        security: { schemes: { apiKey: bearer }, scopes: { anyone: [] } },
      }),
    );
    expect(document.paths['/status'].get.security).toBeUndefined();
    expect(document.paths['/status'].get.responses['401']).toBeUndefined();
  });

  test('an endpoint without its own scope is described under the auth hook default scope', () => {
    const get = service.methods.get;
    if (!get) throw new Error('the fixture has a get method');
    const unscoped = { ...service, methods: { get: { ...get, scope: undefined } } };
    const document = json(
      generateOpenApiDocument({
        info: { title: 'Default', version: '1' },
        services: [unscoped],
        security: {
          schemes: { apiKey: bearer },
          scopes: { account: ['apiKey'] },
          defaultScope: 'account',
        },
      }),
    );
    expect(document.paths['/transcriptions/{id}'].get.security).toEqual([{ apiKey: [] }]);
    expect(document.paths['/transcriptions/{id}'].get.responses['401']).toBeDefined();
  });

  test('contradictory declarations refuse before any operation is emitted', () => {
    expect(() =>
      publicDocument({ schemes: { apiKey: bearer }, scopes: { account: ['missing'] } }),
    ).toThrow(
      'security.scopes.account names the scheme "missing", which security.schemes does not declare',
    );
    expect(() =>
      publicDocument({
        schemes: { apiKey: bearer },
        scopes: { account: ['apiKey'], public: ['apiKey'] },
      }),
    ).toThrow('security.scopes lists "public", which is open by definition');
    expect(() =>
      publicDocument({ schemes: { 'api key': bearer }, scopes: { account: ['api key'] } }),
    ).toThrow('[stitchkit] openapi: security.schemes');
  });

  test('without security the document is exactly what it was', () => {
    const document = json(publicDocument(undefined));
    expect(document.components).toBeUndefined();
    expect(document.paths['/api/transcriptions/{id}'].get.security).toBeUndefined();
    expect(document.paths['/api/transcriptions/{id}'].get.responses['401']).toBeDefined();
  });
});

describe('the described credential is the one the runtime reads', () => {
  const handler = createHandler({
    groups: [{ pathPrefix: 'api', services: [service] }],
    hooks: {
      authorize: createAuthHook({
        resolve: async (ctx) =>
          ctx.req?.headers.get('authorization') === `Bearer ${API_KEY}`
            ? { id: 'account-1' }
            : null,
        rules: { account: 'authenticated', staff: 'authenticated', public: 'public' },
      }),
    },
  });
  const document = json(
    publicDocument({ schemes: { apiKey: bearer }, scopes: { account: ['apiKey'] } }),
  );

  function request(path: string, headers: Record<string, string> = {}): Promise<Response> {
    return handler(new Request(`http://local${path}`, { headers }));
  }

  test('the scheme the spec names opens the operation, and its absence is a 401', async () => {
    const [scheme] = Object.values(document.components.securitySchemes);
    expect(scheme).toMatchObject({ type: 'http', scheme: 'bearer' });

    const anonymous = await request('/api/transcriptions/t1');
    expect(anonymous.status).toBe(401);
    const authorized = await request('/api/transcriptions/t1', {
      authorization: `Bearer ${API_KEY}`,
    });
    expect(authorized.status).toBe(200);
    expect(await authorized.json()).toEqual({ id: 't1' });
  });

  test('the open operation the spec leaves without security answers without a credential', async () => {
    expect((await request('/api/transcriptions/health')).status).toBe(200);
  });

  test('the generated bytes carry no credential value', () => {
    expect(JSON.stringify(document)).not.toContain(API_KEY);
  });
});
