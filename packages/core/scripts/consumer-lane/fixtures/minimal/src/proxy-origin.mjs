import assert from 'node:assert/strict';
import { createServer, isLoopbackAddress } from 'stitchkit/server';

export async function verifyProxyOrigin() {
  const headers = { host: 'tenant.invalid', 'x-forwarded-proto': 'https' };
  let wrappers = 0;
  const server = createServer({
    hostname: '127.0.0.1',
    port: 0,
    proxyOrigin: { trustedPeer: isLoopbackAddress },
    wrapFetch: (next) => (req, runtime) => {
      wrappers++;
      assert.equal(new URL(req.url).origin, 'https://tenant.invalid');
      assert.equal(runtime.requestIP(req).address, '127.0.0.1');
      runtime.timeout(req, 5);
      return next(req, runtime);
    },
    hooks: {
      onRequest(req) {
        assert.equal(new URL(req.url).protocol, 'https:');
      },
    },
    rawRoutes: [
      {
        method: 'ALL',
        path: '/',
        async handler(req, ctx) {
          assert.equal(ctx.ipAddress, '127.0.0.1');
          const asserted = req.headers.get('origin') ?? req.headers.get('referer');
          if (new URL(asserted).origin !== new URL(req.url).origin)
            return new Response(null, { status: 403 });
          return Response.json({ method: req.method, body: await req.text() });
        },
      },
      {
        method: 'GET',
        path: '/ws',
        handler(req, ctx) {
          return ctx.server.upgrade(req, { data: undefined })
            ? new Response(null)
            : new Response(null, { status: 400 });
        },
      },
    ],
    websocket: {
      open(ws) {
        ws.send('ok');
      },
      message() {
        /* This upgrade control sends no client messages. */
      },
    },
  });
  let client;
  try {
    for (const method of ['GET', 'POST']) {
      const response = await fetch(server.url, {
        method,
        headers: {
          ...headers,
          ...(method === 'GET'
            ? { referer: 'https://tenant.invalid/page' }
            : { origin: 'https://tenant.invalid' }),
        },
        ...(method === 'POST' && { body: 'preserved' }),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        method,
        body: method === 'GET' ? '' : 'preserved',
      });
    }
    assert.equal(
      (await fetch(server.url, { headers: { ...headers, origin: 'https://other.invalid' } }))
        .status,
      403,
    );
    const count = wrappers;
    for (const bad of [
      { 'x-forwarded-proto': 'https,http' },
      { forwarded: 'proto=https' },
      { 'x-forwarded-host': 'other.invalid' },
      { 'x-forwarded-port': '443' },
    ]) {
      assert.equal((await fetch(server.url, { headers: { ...headers, ...bad } })).status, 400);
    }
    assert.equal(wrappers, count);
    client = new WebSocket(`${server.url.replace('http:', 'ws:')}/ws`, { headers });
    await new Promise((resolve, reject) => {
      client.onmessage = (event) => {
        assert.equal(event.data, 'ok');
        resolve();
      };
      client.onerror = () => reject(new Error('packed normalized upgrade failed'));
    });
    const closed = new Promise((resolve) => {
      client.onclose = resolve;
    });
    assert.equal((await server.shutdown()).outcome, 'clean');
    await closed;
  } finally {
    client?.close();
    if (server.status.state === 'running') await server.shutdown();
  }

  for (const policy of [undefined, { trustedPeer: () => false }]) {
    const untrusted = createServer({
      hostname: '127.0.0.1',
      port: 0,
      trustProxy: true,
      proxyOrigin: policy,
      rawRoutes: [{ method: 'GET', path: '/', handler: (req) => Response.json(req.url) }],
    });
    try {
      assert.equal(
        await (
          await fetch(untrusted.url, {
            headers: {
              ...headers,
              'x-forwarded-for': '127.0.0.1',
              'x-forwarded-host': 'spoof.invalid',
            },
          })
        ).json(),
        'http://tenant.invalid/',
      );
    } finally {
      await untrusted.shutdown();
    }
  }
  console.log('packed trusted proxy origin: ok');
}
