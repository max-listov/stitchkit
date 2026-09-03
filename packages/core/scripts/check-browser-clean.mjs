/**
 * Guard: the browser-safe entrypoints must not pull a Node built-in into their
 * bundle graph. A `node:` import reachable from `stitchkit` / `/react` /
 * `/contract` breaks client bundlers (Turbopack: "chunking context does not
 * support external modules: node:module"), and the failure is worse than it
 * sounds: a bundler stubs the module rather than omitting it, so top-level code
 * like `promisify(execFile)` or `new AsyncLocalStorage()` throws while the
 * module is *initialising* and the page never mounts — on every route, not only
 * the one that needed the import.
 *
 * It scans the *built* dist (the real artifact) because the leak was a bundler
 * `--splitting` effect, not visible in the source graph — so it runs after
 * `build:js`.
 *
 * It also guards against a **statically** imported heavy peer creeping back into
 * the root graph: `socket.io-client` must stay lazy (`import(...)`), or a plain
 * `import { defineContract } from 'stitchkit'` fails for a consumer who never
 * installed it. A dynamic `import("…")` is fine — only a static `from "…"` trips.
 *
 * And it checks that every browser-safe entry is actually *reachable*: a module
 * built node-free but missing from the export map is a promise the package
 * cannot keep. That was a real consumer report — `dist/application/schemas.js`
 * existed, no `exports` path led to it, and the only way to the schema was the
 * server entry that breaks the page.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { BROWSER_SOURCES, distOf, ENTRYPOINTS as MANIFEST } from '../entrypoints.mjs';

const DIST = new URL('../dist/', import.meta.url);
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

/**
 * The browser-safe entries, from the one manifest that declares them.
 *
 * This used to be scraped out of the `build:browser` script string — one
 * source of truth better than a hand-kept copy, and still worse than a
 * declaration. A regex over a command line silently dropped an entry written
 * `./src/x.ts` rather than `src/x.ts`, and the guard on it asked whether it
 * had read ANYTHING instead of whether it had read everything.
 */
const ENTRIES = BROWSER_SOURCES.map(distOf);
if (ENTRIES.length === 0) {
  console.error(
    '[check-browser-clean] the entrypoint manifest declares no browser-safe entry',
  );
  process.exit(1);
}

/**
 * `import("./x")` counts too, not only `import "./x"` and `from "./x"`.
 *
 * A dynamic relative import is still an edge into the graph. A walker that
 * cannot see one stops there and reports everything beyond it as clean, which
 * is the most flattering possible way to be wrong.
 */
const IMPORT_RE = /(?:import|from)\s*\(?\s*["'](\.\.?\/[^"']+)["']/g;
const NODE_RE = /["'](node:[a-z/_]+)["']/g;
/**
 * The bare spelling as well as the prefixed one. Our own source always writes
 * `node:fs`, but a dependency inlined into a chunk may carry `fs`, and a gate
 * that knows only the prefixed form calls such a chunk clean.
 */
const BARE_BUILTINS = [
  'assert',
  'async_hooks',
  'buffer',
  'child_process',
  'cluster',
  'crypto',
  'dgram',
  'dns',
  'events',
  'fs',
  'http',
  'http2',
  'https',
  'module',
  'net',
  'os',
  'path',
  'perf_hooks',
  'process',
  'querystring',
  'readline',
  'stream',
  'string_decoder',
  'timers',
  'tls',
  'tty',
  'url',
  'util',
  'v8',
  'vm',
  'worker_threads',
  'zlib',
];
const bareBuiltinRe = new RegExp(
  `(?:import|from)\\s*\\(?\\s*["'](${BARE_BUILTINS.join('|')})(?:/[a-z_]+)?["']`,
  'g',
);
/**
 * Peers that must never be *statically* reachable from a browser-safe entry —
 * only lazily via `import(...)`.
 *
 * Hand-kept, and correctly so: unlike the entry list above this is not a copy of
 * anything. Which peers a given entry is allowed to require cannot be derived
 * from the manifest, because `stitchkit/react` legitimately imports `react` and
 * `react-query-kit` statically — they are optional to the package and mandatory
 * to that entry. This names the one peer the ROOT graph must not require.
 */
const LAZY_PEERS = ['socket.io-client'];
const staticPeerRe = (name) =>
  new RegExp(`(?:^|[^.])(?:import|from)\\s*["']${name.replace(/[.]/g, '\\.')}["']`);

/** All dist files reachable from `entryRel` via relative import/from specifiers. */
function reachable(entryRel, seen = new Set()) {
  if (seen.has(entryRel)) return seen;
  seen.add(entryRel);
  const code = readFileSync(new URL(entryRel, DIST), 'utf8');
  for (const match of code.matchAll(IMPORT_RE)) {
    reachable(join(dirname(entryRel), match[1]), seen);
  }
  return seen;
}

const offenders = [];

const published = new Set(
  Object.values(pkg.exports ?? {})
    .map((entry) => entry?.import)
    .filter(Boolean),
);
// Both directions, and over EVERY entry rather than the browser-safe ones.
//
// The entry lists used to live in `package.json` beside the `exports` map, where
// disagreeing with it was hard to miss. Moving them to a manifest moved them away
// from the thing they must agree with, and only the browser half's check came
// along: deleting a server entry from the manifest left `bun run build` green,
// every gate printing success, the file never emitted, and `package.json` still
// exporting it.
for (const { subpath, source } of MANIFEST) {
  const built = `./dist/${distOf(source)}`;
  if (!published.has(built)) {
    offenders.push(`${subpath}: in the manifest, but no "exports" path leads to ${built}`);
  }
}
const manifestBuilds = new Set(MANIFEST.map((entry) => `./dist/${distOf(entry.source)}`));
for (const [subpath, entry] of Object.entries(pkg.exports ?? {})) {
  if (entry?.import && !manifestBuilds.has(entry.import)) {
    offenders.push(`${subpath}: exported as ${entry.import}, which the manifest never builds`);
  }
}

for (const entry of ENTRIES) {
  for (const file of reachable(entry)) {
    const code = readFileSync(new URL(file, DIST), 'utf8');

    const builtins = [...new Set([...code.matchAll(NODE_RE)].map((m) => m[1]))];
    if (builtins.length) offenders.push(`${entry} → ${file}: ${builtins.join(', ')}`);

    const bare = [...new Set([...code.matchAll(bareBuiltinRe)].map((m) => m[1]))];
    if (bare.length) {
      offenders.push(`${entry} → ${file}: bare Node built-in ${bare.join(', ')}`);
    }

    for (const name of LAZY_PEERS) {
      if (staticPeerRe(name).test(code)) {
        offenders.push(`${entry} → ${file}: static import of lazy peer "${name}"`);
      }
    }
  }
}

if (offenders.length > 0) {
  console.error(
    `[check-browser-clean] browser-safe entries are not clean:\n${offenders.join('\n')}`,
  );
  process.exit(1);
}
console.log(`[check-browser-clean] ${ENTRIES.length} browser-safe entries are node-free`);
