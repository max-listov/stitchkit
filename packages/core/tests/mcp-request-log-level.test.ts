/**
 * The request line of an MCP endpoint mounted the way an application mounts it:
 * `createServer` + `createMcpHttpRoute`. A Streamable HTTP client opens its event
 * stream with `GET`; a stateless endpoint answers `405`, which the protocol names
 * as the way to say "no stream here" — the official client treats it as the end of
 * the stream, not a failure. That answer is a protocol outcome, so the line is
 * `info`. Every other `4xx` keeps `warn`: the `401` of a missing token on the same
 * path, a `405` to a method the protocol does not route there, and a `404` beside it.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineContract } from '../src/entrypoints/contract';
import type { StitchLogger } from '../src/entrypoints/server';
import { createServer, implement } from '../src/entrypoints/server';
import { levelForStatus } from '../src/server/logger';
import { createMcpHandler, createMcpHttpRoute } from '../src/tools/mcp/handler';

const TOKEN = 'Bearer probe-token';

function pingService() {
  const contract = defineContract(
    { prefix: 'ping' },
    { get: { method: 'GET', path: '/', desc: 'Ping', output: z.object({ ok: z.boolean() }) } },
  );
  return implement(contract, { get: () => ({ ok: true }) });
}

function mcpRoute() {
  const handler = createMcpHandler({
    access: { open: 'local-operator' },
    serverInfo: { name: 'log-level-probe', version: '1' },
    auth: (req) => (req.headers.get('authorization') === TOKEN ? { id: 'probe' } : null),
    legacy: 'serve',
    services: [],
  });
  return { handler, route: createMcpHttpRoute({ path: '/mcp', handler }) };
}

interface Seen {
  level: string;
  status: number;
}

type Probe = (path: string, init: RequestInit) => Promise<Seen>;

/** Requests the probes send; each is answered and logged once. */
const STREAM_OPEN: RequestInit = {
  method: 'GET',
  headers: { accept: 'text/event-stream', authorization: TOKEN },
};

/** One server per sink, started once; each probe returns the one completion line it caused. */
function serverWith(sink: 'built-in' | 'logger'): {
  probe: Probe;
  start: () => void;
  stop: () => Promise<void>;
} {
  const lines: Seen[] = [];
  const record =
    (level: string): StitchLogger['info'] =>
    (_msg, fields) => {
      if (typeof fields?.status === 'number') lines.push({ level, status: fields.status });
    };
  const logger: StitchLogger = {
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    debug: record('debug'),
  };
  const { handler, route } = mcpRoute();
  let server: ReturnType<typeof createServer> | undefined;
  const original = console.log;

  return {
    start: () => {
      if (sink === 'built-in') {
        console.log = (...args: unknown[]) => {
          const text = args.join(' ');
          if (!text.startsWith('{')) return;
          const parsed = z
            .object({ level: z.string(), status: z.number() })
            .safeParse(JSON.parse(text));
          if (parsed.success) lines.push(parsed.data);
        };
      }
      server = createServer({
        services: [pingService()],
        rawRoutes: [route],
        port: 0,
        logging: sink === 'built-in' ? { format: 'json' } : { logger },
      });
    },
    stop: async () => {
      console.log = original;
      await server?.shutdown({ gracePeriodMs: 0 });
      await handler.close();
    },
    probe: async (path, init) => {
      if (!server) throw new Error('server not started');
      const before = lines.length;
      const res = await fetch(`http://localhost:${server.port}${path}`, init);
      await res.arrayBuffer();
      const added = lines.slice(before);
      expect(added).toHaveLength(1);
      const [line] = added;
      if (!line) throw new Error('no completion line');
      expect(line.status).toBe(res.status);
      return line;
    },
  };
}

describe('levelForStatus — the protocol mark lowers only a 4xx', () => {
  test('a marked 4xx is info, a marked 5xx stays an error, an unmarked 4xx a warning', () => {
    expect(levelForStatus(405, 'protocol')).toBe('info');
    expect(levelForStatus(503, 'protocol')).toBe('error');
    expect(levelForStatus(405)).toBe('warn');
    expect(levelForStatus(499)).toBe('info');
    expect(levelForStatus(200, 'protocol')).toBe('info');
  });
});

for (const sink of ['built-in', 'logger'] as const) {
  describe(`MCP request line level — ${sink} sink`, () => {
    const server = serverWith(sink);
    beforeAll(server.start);
    afterAll(server.stop);

    test('GET that opens the event stream is answered 405 and logged info', async () => {
      expect(await server.probe('/mcp', STREAM_OPEN)).toEqual({ level: 'info', status: 405 });
    });

    test('DELETE that ends a session is answered 405 and logged info', async () => {
      const seen = await server.probe('/mcp', {
        method: 'DELETE',
        headers: { authorization: TOKEN },
      });
      expect(seen).toEqual({ level: 'info', status: 405 });
    });

    test('GET without a token stays a warn 401', async () => {
      const seen = await server.probe('/mcp', {
        method: 'GET',
        headers: { accept: 'text/event-stream' },
      });
      expect(seen).toEqual({ level: 'warn', status: 401 });
    });

    test('a 405 to a method the protocol does not route here stays warn', async () => {
      const seen = await server.probe('/mcp', {
        method: 'PUT',
        headers: { authorization: TOKEN, 'content-type': 'application/json' },
        body: '{}',
      });
      expect(seen).toEqual({ level: 'warn', status: 405 });
    });

    test('a 4xx outside the MCP endpoint stays warn', async () => {
      expect(await server.probe('/missing', { method: 'GET' })).toEqual({
        level: 'warn',
        status: 404,
      });
    });
  });
}
