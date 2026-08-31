import assert from 'node:assert/strict';
import { AppError, defineContract } from 'stitchkit/contract';
import { serveNode } from 'stitchkit/node';
import { createServer, implement } from 'stitchkit/server';
import { z } from 'zod';

const contract = defineContract(
  { prefix: 'items' },
  {
    save: {
      method: 'POST',
      path: '/:id',
      desc: 'Save item',
      params: z.object({ id: z.string().min(2) }),
      input: z.object({ name: z.string() }),
      output: z.object({ ok: z.boolean() }),
    },
  },
);
const original = new AppError('UNAUTHORIZED', 'Unauthorized', 401);
const hookFailure = new Error('private error hook failure');
const service = implement(contract, {
  save: () => {
    throw original;
  },
});
const calls = [];
const diagnostics = [];
const noop = () => undefined;
const config = {
  port: 0,
  hostname: '127.0.0.1',
  cors: { origin: '*' },
  logging: {
    logger: {
      info: noop,
      debug: noop,
      warn: noop,
      error: (_message, fields) => {
        if (fields?.error) diagnostics.push(fields.error);
      },
    },
  },
  groups: [
    {
      pathPrefix: '/group',
      services: [service],
      hooks: {
        authorize: (ctx) => {
          if (ctx.req.headers.has('x-reject-auth')) throw original;
        },
        onError: (ctx, error, endpoint) => {
          calls.push({ scope: 'group', ctx, error, endpoint });
          const mode = ctx.req.headers.get('x-error-mode');
          if (mode === 'throw' || mode === 'default') throw hookFailure;
          if (mode === 'reject') return Promise.reject(hookFailure);
          if (mode === 'fallthrough') return undefined;
          return new Response('group', {
            status: 401,
            headers: { 'cache-control': 'no-store' },
          });
        },
      },
    },
  ],
  hooks: {
    onError: (ctx, error, endpoint) => {
      calls.push({ scope: 'global', ctx, error, endpoint });
      if (ctx.req.headers.get('x-error-mode') === 'default') throw hookFailure;
      return new Response('global', { status: 401 });
    },
  },
};
const server = process.versions.bun ? createServer(config) : await serveNode(config);
try {
  for (const sample of [
    { name: 'authorization', headers: { 'x-reject-auth': 'yes' } },
    { name: 'path validation', id: 'x' },
    { name: 'payload validation', body: {} },
    { name: 'handler' },
    { name: 'fallthrough', headers: { 'x-error-mode': 'fallthrough' }, fallback: true },
    { name: 'throw', headers: { 'x-error-mode': 'throw' }, fallback: true, diagnostics: 1 },
    { name: 'reject', headers: { 'x-error-mode': 'reject' }, fallback: true, diagnostics: 1 },
    {
      name: 'default',
      headers: { 'x-error-mode': 'default' },
      fallback: true,
      diagnostics: 2,
    },
  ]) {
    calls.length = 0;
    diagnostics.length = 0;
    const response = await fetch(
      `http://127.0.0.1:${server.port}/group/items/${sample.id ?? 'abc'}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...sample.headers },
        body: JSON.stringify(sample.body ?? { name: 'item' }),
      },
    );
    assert.equal(response.status, 401, sample.name);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.ok(response.headers.get('x-request-id'));
    assert.deepEqual(
      calls.map((call) => call.scope),
      sample.fallback ? ['group', 'global'] : ['group'],
    );
    assert.equal(calls[0].endpoint.key, 'save');
    assert.equal(calls[0].endpoint.serviceName, 'items');
    assert.deepEqual(calls[0].ctx.params, { id: sample.id ?? 'abc' });
    if (sample.fallback) {
      assert.equal(calls[1].error, original);
      assert.equal(calls[1].error, calls[0].error);
      assert.equal(calls[1].ctx, calls[0].ctx);
      assert.equal(calls[1].endpoint, calls[0].endpoint);
    } else assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(diagnostics, Array(sample.diagnostics ?? 0).fill(hookFailure));
    if (sample.name === 'default') {
      assert.deepEqual(await response.json(), {
        error: { code: 'UNAUTHORIZED', message: 'Unauthorized' },
      });
    } else assert.equal(await response.text(), sample.fallback ? 'global' : 'group');
  }
} finally {
  await server.shutdown({ gracePeriodMs: 0 });
}
console.log('packed route group errors: ok');
