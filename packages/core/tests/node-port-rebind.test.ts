/**
 * The 0.59.2 fix: `serveNode({ port: 0 })` must not expose a port that Fetch
 * refuses to connect to. The kernel hands one out rarely, so a test that waits
 * for that to happen proves nothing — the only honest way to pin the rebind is
 * to make the first allocation look blocked and watch the server move.
 */
import { afterEach, expect, mock, test } from 'bun:test';

const seenPorts: number[] = [];
let blockNext = true;

mock.module('../src/internal/fetch-port', () => ({
  isFetchBlockedPort: (port: number): boolean => {
    seenPorts.push(port);
    if (!blockNext) return false;
    blockNext = false;
    return true;
  },
}));

const { serveNode } = await import('../src/server/node');

afterEach(() => {
  seenPorts.length = 0;
  blockNext = true;
});

test('a Fetch-blocked ephemeral allocation is rebound before the handle is exposed', async () => {
  const server = await serveNode({ services: [], port: 0 });
  try {
    // Two candidates inspected: the blocked one was closed, the second kept.
    expect(seenPorts.length).toBeGreaterThanOrEqual(2);
    expect(seenPorts[0]).not.toBe(server.port);
    expect(seenPorts.at(-1)).toBe(server.port);

    // And the surviving allocation is a real, reachable listener.
    const response = await fetch(`http://127.0.0.1:${server.port}/does-not-exist`);
    expect(response.status).toBe(404);
  } finally {
    await server.shutdown({ gracePeriodMs: 0 });
  }
});
