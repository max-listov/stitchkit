import assert from 'node:assert/strict';
import { mkdtemp, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineContract } from 'stitchkit';
import { createApplication, managedServerResource } from 'stitchkit/application';
import { implement } from 'stitchkit/server';
import { z } from 'zod';

const watchdog = setTimeout(() => {
  console.error('stream shutdown watchdog expired');
  process.exit(1);
}, 10_000);
try {
  const bun = typeof Bun !== 'undefined';
  for (const transport of bun ? ['tcp', 'unix'] : ['tcp']) {
    for (const format of ['ndjson', 'sse']) {
      for (const finite of [true, false]) {
        const directory = await mkdtemp(join(tmpdir(), 'stream-shutdown-'));
        const path = join(directory, 'server.sock');
        const contract = defineContract(
          { prefix: 'probe' },
          {
            events: {
              method: 'GET',
              path: '/',
              desc: 'Observe a cooperative stream',
              stream: { item: z.object({ ready: z.boolean() }), format, heartbeatMs: 100 },
            },
          },
        );
        let sourceAborted = false;
        let sourceReturned = false;
        const service = implement(contract, {
          events: async function* ({ signal }) {
            try {
              yield { ready: true };
              if (!finite)
                await new Promise((resolve) => {
                  const aborted = () => {
                    sourceAborted = true;
                    resolve();
                  };
                  if (signal.aborted) aborted();
                  else signal.addEventListener('abort', aborted, { once: true });
                });
            } finally {
              sourceReturned = true;
            }
          },
        });
        const config = { services: [service], logging: false };
        const server = bun
          ? (await import('stitchkit/server')).createServer({
              ...config,
              ...(transport === 'unix' ? { unix: { path, mode: 0o600 } } : { port: 0 }),
            })
          : await (await import('stitchkit/node')).serveNode({ ...config, port: 0 });
        const app = createApplication({
          id: 'stream-probe',
          resources: [managedServerResource({ id: 'http', server })],
          shutdown: { gracePeriodMs: 100, forceTimeoutMs: 200 },
        });
        await app.start();
        const client = new AbortController();
        const response = await fetch(
          transport === 'unix' ? 'http://localhost/probe' : `${server.url}/probe`,
          {
            signal: client.signal,
            ...(transport === 'unix' && { unix: path }),
          },
        );
        assert.equal(response.status, 200);
        const reader = response.body.getReader();
        let received = '';
        while (!received.includes('ready')) {
          const next = await reader.read();
          assert.equal(next.done, false);
          received += new TextDecoder().decode(next.value);
        }
        if (finite)
          while (!(await reader.read()).done) {
            /* Drain the finite control. */
          }
        const result = await app.shutdown();
        const observed = {
          transport,
          format,
          finite,
          cleanupComplete: result.cleanupComplete,
          sourceAborted,
          sourceReturned,
          pendingRequests: server.status.pendingRequests,
        };
        console.log(JSON.stringify(observed));
        client.abort();
        await reader.cancel().catch(() => undefined);
        assert.equal(observed.cleanupComplete, true);
        assert.equal(observed.sourceReturned, true);
        assert.equal(observed.pendingRequests, 0);
        if (!finite) assert.equal(observed.sourceAborted, true);
        await rmdir(directory);
      }
    }
  }
  console.log('packed stream shutdown: ok');
} finally {
  clearTimeout(watchdog);
}
