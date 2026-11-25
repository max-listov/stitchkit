/**
 * `stitchkit/realtime` binds a contract to a socket the caller already holds, without the
 * root entry. A native app shares one Socket.IO connection between watched reads and an
 * agent controller; its bundle must not reach the root default peer loader, a computed
 * `import()` the Hermes compiler refuses. The source graph, the retained browser bundle
 * and a binding run in the React Native 0.88 realm each prove one part of that.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from '@typescript/typescript6';
import { z } from 'zod';
import {
  bindRealtimeClient,
  createSocketIOClient,
  defineRealtimeContract,
  type RealtimeClientTransport,
} from '../../src/entrypoints/realtime';
import { bundleBrowserIife, CORE_SRC, createRnRealm, ZOD_ENTRY } from './rn-realm';

const REALTIME_ENTRY = join(CORE_SRC, 'entrypoints/realtime.ts');
const ROOT_ENTRY = join(CORE_SRC, 'entrypoints/index.ts');
const DEFAULT_PEER = 'browser/socket-io-default-peer.ts';

/** Every dynamic `import()` whose specifier is not a string literal, as written. */
function computedImports(code: string): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      !(node.arguments[0] && ts.isStringLiteralLike(node.arguments[0]))
    )
      found.push(node.getText(source));
    ts.forEachChild(node, visit);
  };
  const source = ts.createSourceFile('bundle.js', code, ts.ScriptTarget.Latest, true);
  visit(source);
  return found;
}

const transpiler = new Bun.Transpiler({ loader: 'ts' });

function resolveSource(from: string, specifier: string): string {
  const base = resolve(dirname(from), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (candidate.endsWith('.ts') || candidate.endsWith('.tsx'))
      if (existsSync(candidate)) return candidate;
  }
  throw new Error(`cannot resolve ${specifier} from ${from}`);
}

/** Every source module a bundler loads from `entry`; type-only imports carry no code. */
function sourceGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const { path } of transpiler.scanImports(readFileSync(file, 'utf8'))) {
      if (path.startsWith('.')) visit(resolveSource(file, path));
    }
  };
  visit(entry);
  return new Set([...seen].map((file) => relative(CORE_SRC, file)));
}

const contract = defineRealtimeContract({
  serverToClient: { changed: { args: z.tuple([z.object({ version: z.number() })]) } },
  clientToServer: {
    watch: {
      args: z.tuple([z.object({ topic: z.string() })]),
      ack: z.object({ accepted: z.boolean() }),
    },
  },
});

const realtimeBundlePromise = bundleBrowserIife(`
  import * as realtime from ${JSON.stringify(REALTIME_ENTRY)};
  import { z } from ${JSON.stringify(ZOD_ENTRY)};
  // Metro keeps a barrel's exports: retain the whole realtime surface.
  globalThis.__skRealtime = { realtime, z };
`);

describe('stitchkit/realtime binds an existing transport without the root entry', () => {
  test('a socket the caller created stays the one the binding uses', async () => {
    const socket = createSocketIOClient({
      url: 'http://127.0.0.1',
      peers: { client: () => import('socket.io-client') },
    });
    const transport: RealtimeClientTransport = socket;
    const bound = bindRealtimeClient(contract, transport);
    expect(bound.connected).toBe(false);
    expect('connect' in bound).toBe(false);
    socket.disconnect();
  });

  test('the source graph reaches the binding and neither the root entry nor its default peer', () => {
    const graph = sourceGraph(REALTIME_ENTRY);
    expect(graph.has('browser/realtime-client.ts')).toBe(true);
    expect(graph.has('entrypoints/index.ts')).toBe(false);
    expect(graph.has(DEFAULT_PEER)).toBe(false);
    // Control: the walker does see the default peer where it lives.
    expect(sourceGraph(ROOT_ENTRY).has(DEFAULT_PEER)).toBe(true);
  });

  test('the retained browser bundle has no computed import, unlike the root bundle', async () => {
    const bundle = await realtimeBundlePromise;
    expect(bundle).toContain('function bindRealtimeClient');
    expect(bundle).not.toMatch(/SOCKET_IO_CLIENT|webpackIgnore/);
    expect(computedImports(bundle)).toEqual([]);
    // Control: the detector finds the root entry's default peer loader.
    const root = await bundleBrowserIife(`
      import * as root from ${JSON.stringify(ROOT_ENTRY)};
      globalThis.__skRoot = root;
    `);
    expect(computedImports(root)).toEqual(['import(SOCKET_IO_CLIENT)']);
  });

  test('a binding validates inbound events and acknowledgements in the RN 0.88 realm', async () => {
    const realm = createRnRealm();
    realm.evaluate(await realtimeBundlePromise, 'realtime-bind.js');
    const result = await realm.evaluate<
      Promise<{
        received: unknown[];
        rejected: string[];
        acknowledgement: unknown;
        emitted: unknown[];
        invalidOutbound: string;
      }>
    >(`(async () => {
      const { realtime, z } = globalThis.__skRealtime;
      const contract = realtime.defineRealtimeContract({
        serverToClient: { changed: { args: z.tuple([z.object({ version: z.number() })]) } },
        clientToServer: {
          watch: {
            args: z.tuple([z.object({ topic: z.string() })]),
            ack: z.object({ accepted: z.boolean() }),
          },
        },
      });
      const handlers = new Map();
      const emitted = [];
      const transport = {
        connected: true,
        on(event, handler) {
          handlers.set(event, handler);
          return () => handlers.delete(event);
        },
        emit(event, ...args) {
          emitted.push([event, args]);
          return true;
        },
        emitWithAck(event, args, options) {
          emitted.push([event, args, options.timeoutMs]);
          return Promise.resolve({ accepted: true });
        },
        onConnectionChange() {
          return () => undefined;
        },
      };
      const rejected = [];
      const bound = realtime.bindRealtimeClient(contract, transport, {
        onRejected: ({ event, phase }) => rejected.push(event + ':' + phase),
      });
      const received = [];
      bound.on('changed', (value) => received.push(value));
      handlers.get('changed')({ version: 2 });
      handlers.get('changed')({ version: 'two' });
      const acknowledgement = await bound.request('watch', { topic: 'tasks' }, { timeoutMs: 500 });
      let invalidOutbound = '';
      try {
        bound.emit('watch', { topic: 3 });
      } catch (error) {
        invalidOutbound = error.name;
      }
      return { received, rejected, acknowledgement, emitted, invalidOutbound };
    })()`);
    expect(realm.errors).toEqual([]);
    expect(result.received).toEqual([{ version: 2 }]);
    expect(result.rejected).toEqual(['changed:arguments']);
    expect(result.acknowledgement).toEqual({ accepted: true });
    expect(result.emitted).toEqual([['watch', [{ topic: 'tasks' }], 500]]);
    expect(result.invalidOutbound).not.toBe('');
  });
});
