import { expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * A re-export outside `src/entrypoints/` is a second path to a name its owner already serves.
 * The entrypoints are re-exports by design; anywhere else the count only shrinks. Each module
 * below is listed with how many `export … from` statements it holds and why they stay; a new
 * one is imported from its owner instead, and a module that drops one lowers its number here.
 */
const FRONT_DOOR = 'the part’s front door: its entrypoint imports the part through this index';
const SPLIT =
  'the names live in a sibling contract, schema or state file of this module; this module stays the one path its entrypoint and in-part callers import';
const INTERNAL_TYPE =
  'a name owned by internal/ shown on the public module whose signatures use it; the entrypoint imports it from here';
const DRIVER = 'a driver module serves the store it drives under its own path';
const OTHER_AREA =
  'lives in an area another task owns this round (sync/, tools/mcp/, the surface projector); counted, not changed here';

const REEXPORTS: Readonly<
  Record<string, { readonly statements: number; readonly reason: string }>
> = {
  'agent-executor/acp/v1-driver.ts': { statements: 2, reason: SPLIT },
  'agent-runtime/children.ts': { statements: 3, reason: SPLIT },
  'agent-runtime/coding-tools.ts': { statements: 1, reason: SPLIT },
  'agent-runtime/deferred-tools.ts': { statements: 1, reason: SPLIT },
  'agent-runtime/events.ts': { statements: 1, reason: SPLIT },
  'agent-runtime/harness.ts': { statements: 3, reason: SPLIT },
  'agent-runtime/openrouter.ts': {
    statements: 1,
    reason: 'the catalog fetch type beside the factory that takes it',
  },
  'agent-runtime/schemas.ts': { statements: 6, reason: SPLIT },
  'agent-runtime/sqlite-bun.ts': { statements: 3, reason: DRIVER },
  'agent-runtime/sqlite-node.ts': { statements: 3, reason: DRIVER },
  'agent-runtime/sqlite.ts': { statements: 1, reason: INTERNAL_TYPE },
  'application/decisions.ts': { statements: 2, reason: INTERNAL_TYPE },
  'application/diagnostic-journal-contract.ts': { statements: 1, reason: SPLIT },
  'browser/client.ts': {
    statements: 1,
    reason:
      'ClientFetch from ./transport, the type of the fetch option createClient takes; two entrypoints and testing/ import it here — candidate for removal',
  },
  'browser/socket-io.ts': { statements: 1, reason: SPLIT },
  'browser/stream.ts': { statements: 2, reason: INTERNAL_TYPE },
  'contract/define.ts': {
    statements: 2,
    reason:
      'PathParams (internal/route-pattern) and the transport list (./transports), both in the signature of defineContract',
  },
  'durability/engine.ts': { statements: 2, reason: SPLIT },
  'files/boundary.ts': { statements: 1, reason: INTERNAL_TYPE },
  'geo/index.ts': { statements: 5, reason: FRONT_DOOR },
  'internal/with-exclusive-lock.ts': { statements: 1, reason: INTERNAL_TYPE },
  'live/events.ts': { statements: 1, reason: INTERNAL_TYPE },
  'primitives/index.ts': { statements: 15, reason: FRONT_DOOR },
  'react/keyboard/testing.ts': {
    statements: 2,
    reason:
      'the testing module hands the layer stack and the nav zone to tests under its own entrypoint',
  },
  'realtime/index.ts': { statements: 4, reason: FRONT_DOOR },
  'server/middleware/pkce.ts': { statements: 1, reason: INTERNAL_TYPE },
  'server/socket-io-node.ts': { statements: 1, reason: SPLIT },
  'server/socket-io.ts': { statements: 1, reason: SPLIT },
  'server/types.ts': { statements: 1, reason: INTERNAL_TYPE },
  'server/unix-client.ts': { statements: 1, reason: INTERNAL_TYPE },
  'service-host/config-reloader.ts': { statements: 2, reason: SPLIT },
  'sync/session.ts': { statements: 1, reason: OTHER_AREA },
  'telegram/broadcast.ts': { statements: 1, reason: SPLIT },
  'telegram/transport.ts': { statements: 1, reason: SPLIT },
  'testing/managed-resource-conformance.ts': { statements: 1, reason: SPLIT },
  'testing/surface-manifest.ts': { statements: 1, reason: OTHER_AREA },
  'tools/cli/publication.ts': { statements: 1, reason: SPLIT },
  'tools/mcp/prepare.ts': { statements: 1, reason: OTHER_AREA },
  'tools/runtime-tool.ts': { statements: 2, reason: SPLIT },
};

const REEXPORT = /^export (?:type )?(?:\*(?: as \w+)?|\{[^}]*\}) from '[^']+';/gm;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(path) ? [path] : [];
  });
}

test('the pattern counts every form of a re-export and no local export', () => {
  const sample = [
    "export * from './a';",
    "export * as b from './b';",
    "export type { C } from './c';",
    "export {\n  d,\n  type E,\n} from './d';",
    'export const f = 1;',
    'export { g };',
    "import { h } from './h';",
  ].join('\n');
  expect(sample.match(REEXPORT)?.length).toBe(4);
});

test('re-exports outside the entrypoints only shrink, and each module that keeps one says why', () => {
  const root = join(import.meta.dir, '..', 'src');
  const counted: Record<string, number> = {};
  for (const path of sourceFiles(root)) {
    const name = relative(root, path);
    if (name.startsWith('entrypoints/')) continue;
    const statements = readFileSync(path, 'utf8').match(REEXPORT)?.length ?? 0;
    if (statements > 0) counted[name] = statements;
  }
  const expected = Object.fromEntries(
    Object.entries(REEXPORTS).map(([name, entry]) => [name, entry.statements]),
  );
  expect(counted).toEqual(expected);
  const total = Object.values(counted).reduce((sum, statements) => sum + statements, 0);
  expect(total).toBe(81);
});
