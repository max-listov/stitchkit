/**
 * Guard: the browser-safe entrypoints must not pull a Node built-in into their
 * bundle graph. A `node:` import reachable from `stitchkit` / `/react` /
 * `/contract` breaks client bundlers (Turbopack: "chunking context does not
 * support external modules: node:module"). This scans the *built* dist (the real
 * artifact) because the leak was a bundler `--splitting` effect, not visible in
 * the source graph — so it runs after `build:js`.
 *
 * It also guards against a **statically** imported heavy peer creeping back into
 * the root graph: `socket.io-client` must stay lazy (`import(...)`), or a plain
 * `import { defineContract } from 'stitchkit'` fails for a consumer who never
 * installed it. A dynamic `import("…")` is fine — only a static `from "…"` trips.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const DIST = new URL('../dist/', import.meta.url);
const ENTRIES = [
  'index.js',
  'react.js',
  'contract/index.js',
  'declaration.js',
  'agent-runtime-browser.js',
];
const IMPORT_RE = /(?:import|from)\s*["'](\.\.?\/[^"']+)["']/g;
const NODE_RE = /["'](node:[a-z/_]+)["']/g;
// Peers that must never be *statically* reachable from a browser-safe entry —
// only lazily via `import(...)`. A static `import x from 'pkg'` / `from "pkg"`.
const LAZY_PEERS = ['socket.io-client'];
const staticPeerRe = (pkg) =>
  new RegExp(`(?:^|[^.])(?:import|from)\\s*["']${pkg.replace(/[.]/g, '\\.')}["']`);

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
for (const entry of ENTRIES) {
  for (const file of reachable(entry)) {
    const builtins = [
      ...new Set(
        [...readFileSync(new URL(file, DIST), 'utf8').matchAll(NODE_RE)].map((m) => m[1]),
      ),
    ];
    if (builtins.length) offenders.push(`${entry} → ${file}: ${builtins.join(', ')}`);

    const code = readFileSync(new URL(file, DIST), 'utf8');
    for (const pkg of LAZY_PEERS) {
      if (staticPeerRe(pkg).test(code)) {
        offenders.push(`${entry} → ${file}: static import of lazy peer "${pkg}"`);
      }
    }
  }
}

if (offenders.length > 0) {
  console.error(
    `[check-browser-clean] Node built-ins reachable from a browser-safe entry:\n${offenders.join('\n')}`,
  );
  process.exit(1);
}
console.log('[check-browser-clean] browser-safe entries are node-free');
