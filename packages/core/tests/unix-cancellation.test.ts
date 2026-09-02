import { describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createClient } from '../src/browser/client';
import { defineContract } from '../src/contract/index';
import { createServer, implement } from '../src/server/index';
import { createUnixClientTransport } from '../src/server/unix-client';

/**
 * A caller's cancellation has to reach the handler over the unix transport too.
 *
 * Reported as a defect — the Bun lane was said to receive no signal at all — and it did not
 * reproduce: the lane listens to `request.signal` and both transports abort within ~310 ms of the
 * caller. What did reproduce, three times, was the reporter's likely mistake and mine:
 * `client.op(args, { signal })` drops the options in silence, so the request runs to completion
 * while the caller believes it was cancelled. That is why this test uses `withOptions`, and why
 * the TCP control sits beside it: without the control, a green here would not distinguish
 * "cancellation propagates" from "the probe never cancelled anything".
 */
const contract = defineContract(
  { prefix: 'c' },
  {
    wait: {
      method: 'POST',
      path: '/wait',
      desc: 'Wait, watching the signal',
      input: z.object({ n: z.number() }),
      output: z.object({ ok: z.boolean() }),
    },
  },
);

async function abortDuring(transport: 'tcp' | 'unix'): Promise<number | null> {
  let sawAbortAtMs: number | null = null;
  const socketPath = join(tmpdir(), `sk-cancel-${transport}-${Date.now()}.sock`);
  const service = implement(contract, {
    async wait(ctx: { signal?: AbortSignal }) {
      const startedAt = performance.now();
      while (performance.now() - startedAt < 3_000) {
        if (ctx.signal?.aborted) {
          sawAbortAtMs = Math.round(performance.now() - startedAt);
          return { ok: true };
        }
        await Bun.sleep(20);
      }
      return { ok: true };
    },
  });
  const server =
    transport === 'tcp'
      ? createServer({ port: 0, logging: false, services: [service] })
      : createServer({ unix: socketPath, logging: false, services: [service] });
  const client =
    transport === 'tcp'
      ? createClient(contract, { baseUrl: server.url })
      : createClient(contract, {
          baseUrl: 'http://localhost',
          fetch: createUnixClientTransport({ socketPath }).fetch,
        });
  try {
    const controller = new AbortController();
    const call = client.wait.withOptions({ n: 1 }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 200);
    await expect(call).rejects.toThrow();
    // The handler needs a moment to observe the aborted signal after the socket goes.
    await Bun.sleep(500);
    return sawAbortAtMs;
  } finally {
    void server.runtime?.stop(true);
    if (transport === 'unix') await rm(socketPath, { force: true });
  }
}

describe('caller cancellation reaches the handler', () => {
  test('over the unix transport, and identically over TCP', async () => {
    const overTcp = await abortDuring('tcp');
    const overUnix = await abortDuring('unix');
    // Both must observe it, and well inside the handler's own 3 s ceiling — a value near 3 000
    // would mean the loop simply ran out rather than being cancelled.
    expect(overTcp).not.toBeNull();
    expect(overUnix).not.toBeNull();
    expect(overTcp ?? Number.POSITIVE_INFINITY).toBeLessThan(1_500);
    expect(overUnix ?? Number.POSITIVE_INFINITY).toBeLessThan(1_500);
  }, 30_000);
});
