/**
 * A consumer-lane fixture listens on a port its Fetch client may call.
 *
 * An operating system with a wide ephemeral range hands `listen(0)` ports
 * WHATWG Fetch refuses before any request (`bad port`); a fixture that took
 * one failed the lane while the product was fine. The support module rebinds
 * until the port is above the block list. These tests substitute the
 * allocation instead of waiting for an unlucky draw.
 */
import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import {
  HIGHEST_FETCH_BLOCKED_PORT,
  listenFetchable,
} from '../scripts/consumer-lane/fixture-support/listen-fetchable.mjs';
import { isFetchBlockedPort } from '../src/internal/fetch-port';

/** A server whose `listen(0)` hands out the given ports in order. */
class AllocatingServer extends EventEmitter {
  closed = 0;
  private port: number | undefined;
  constructor(private readonly ports: number[]) {
    super();
  }
  listen(_port: number, _host: string, done: () => void): void {
    this.port = this.ports.shift();
    queueMicrotask(done);
  }
  address(): { port: number } | null {
    return this.port === undefined ? null : { port: this.port };
  }
  close(done: (error?: Error) => void): void {
    this.closed += 1;
    this.port = undefined;
    queueMicrotask(() => done());
  }
}

describe('listenFetchable', () => {
  test('the block list ends where the module says it does', () => {
    expect(isFetchBlockedPort(HIGHEST_FETCH_BLOCKED_PORT)).toBe(true);
    const above = Array.from(
      { length: 65_535 - HIGHEST_FETCH_BLOCKED_PORT },
      (_, index) => index,
    );
    expect(
      above.some((offset) => isFetchBlockedPort(HIGHEST_FETCH_BLOCKED_PORT + 1 + offset)),
    ).toBe(false);
  });

  test('a blocked allocation is closed and the next one above the list is kept', async () => {
    const server = new AllocatingServer([6000, 10080, 40_123]);
    expect(await listenFetchable(server)).toBe(40_123);
    expect(server.closed).toBe(2);
  });

  test('a run of low allocations ends in a named refusal, not a blocked port', async () => {
    const server = new AllocatingServer(Array.from({ length: 64 }, () => 6566));
    await expect(listenFetchable(server)).rejects.toThrow('no ephemeral port above 10080');
  });

  test('a real loopback server gets a port Fetch can call', async () => {
    const server = createServer((_request, response) => response.end('ok'));
    const port = await listenFetchable(server);
    try {
      expect(port).toBeGreaterThan(HIGHEST_FETCH_BLOCKED_PORT);
      expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe('ok');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
