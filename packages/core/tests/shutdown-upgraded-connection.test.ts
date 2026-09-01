import { describe, expect, test } from 'bun:test';
import { io } from 'socket.io-client';
import { createServer } from '../src/server/bun';
import { createSocketIOServer } from '../src/server/socket-io';

/**
 * A finite response in flight beside a WebSocket must still shut down cleanly.
 *
 * Bun's `stop()` Promise never settles once a connection has been upgraded. The adapter knew
 * that and guarded the branch it takes when nothing is pending — and awaited `stop(false)`
 * unguarded on the branch it takes when something is. So a server that had ever seen an upgrade
 * reported `forced`/`deadline` for work that had already drained, and the counters said so:
 * `pendingRequests` 0, `abortedRequests` 0, nothing forced. A shutdown that lies about being
 * forced is worse than a slow one — an operator reading it looks for work that does not exist.
 *
 * The control keeps this honest. Without the socket the same sequence was always clean, so a
 * test that only asserted the WebSocket case could pass on a build that broke both.
 */
async function drainWithShutdown(options: { readonly withSocket: boolean }) {
  const socket = options.withSocket
    ? await createSocketIOServer({ transports: ['websocket'] })
    : undefined;
  // Large enough that the body is genuinely still in flight when shutdown begins.
  const body = new Uint8Array(32 * 1024 * 1024);
  const server = createServer({
    port: 0,
    ...(socket && { socket }),
    logging: false,
    rawRoutes: [{ method: 'GET', path: '/data', handler: () => new Response(body) }],
  });
  const client = options.withSocket
    ? io(server.url, { transports: ['websocket'], reconnection: false })
    : undefined;
  if (client) await new Promise<void>((resolve) => client.once('connect', () => resolve()));

  try {
    const response = await fetch(`${server.url}/data`);
    const stopping = server.shutdown({
      gracePeriodMs: 2_000,
      forceTimeoutMs: 500,
      realtimeCloseTimeoutMs: 100,
    });
    await Bun.sleep(100);
    const received = await response.arrayBuffer();
    expect(received.byteLength).toBe(body.byteLength);
    return await stopping;
  } finally {
    client?.disconnect();
    void server.runtime.stop(true);
  }
}

describe('graceful shutdown with an upgraded connection', () => {
  test('a finite body that drains beside a WebSocket shuts down clean, not forced', async () => {
    const result = await drainWithShutdown({ withSocket: true });
    expect(result.outcome).toBe('clean');
    expect(result.pendingRequests).toBe(0);
    expect(result.abortedRequests).toBe(0);
    expect(result.forcedWebSockets).toBe(0);
  }, 30_000);

  test('control: the same sequence without a WebSocket was never broken', async () => {
    const result = await drainWithShutdown({ withSocket: false });
    expect(result.outcome).toBe('clean');
    expect(result.abortedRequests).toBe(0);
  }, 30_000);
});
