/**
 * Guard: the browser-safe entrypoints must not pull a Node built-in into their
 * bundle graph. A `node:` import reachable from `stitchkit` / `/react` /
 * `/contract` breaks client bundlers (Turbopack: "chunking context does not
 * support external modules: node:module"), and the failure is worse than it
 * sounds: a bundler stubs the module rather than omitting it, so top-level code
 * like `promisify(execFile)` throws while the module is *initialising* and the
 * page never mounts — on every route, not only the one that needed the import.
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

const DIST = new URL('../dist/', import.meta.url);
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

/**
 * The browser lane, read from the build script itself.
 *
 * Derived rather than restated: a hand-kept copy of this list is a second
 * source of truth, and the failure it produces is silence — an entry added to
 * the build and forgotten here is simply never scanned.
 */
const ENTRIES = [
  ...(pkg.scripts['build:browser'] ?? '').matchAll(/(?:^|\s)(src\/[\w./-]+\.tsx?)/g),
].map((match) => match[1].replace(/^src\//, '').replace(/\.tsx?$/, '.js'));

// A derivation that quietly returns nothing would turn this gate into a
// green light over an empty set — the one failure mode a derived list has
// that a literal one does not.
if (ENTRIES.length === 0) {
  console.error('[check-browser-clean] could not read any entry out of `build:browser`');
  process.exit(1);
}

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

const published = new Set(
  Object.values(pkg.exports ?? {})
    .map((entry) => entry?.import)
    .filter(Boolean),
);
for (const entry of ENTRIES) {
  if (!published.has(`./dist/${entry}`)) {
    offenders.push(`${entry}: built for the browser, but no "exports" path leads to it`);
  }
}

for (const entry of ENTRIES) {
  for (const file of reachable(entry)) {
    const builtins = [
      ...new Set(
        [...readFileSync(new URL(file, DIST), 'utf8').matchAll(NODE_RE)].map((m) => m[1]),
      ),
    ];
    if (builtins.length) offenders.push(`${entry} → ${file}: ${builtins.join(', ')}`);

    const code = readFileSync(new URL(file, DIST), 'utf8');
    for (const pkgName of LAZY_PEERS) {
      if (staticPeerRe(pkgName).test(code)) {
        offenders.push(`${entry} → ${file}: static import of lazy peer "${pkgName}"`);
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
